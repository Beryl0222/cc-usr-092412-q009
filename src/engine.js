/**
 * 养老机器人共享结算引擎。
 *
 * 核心约定：
 * - 资格决定、服务包、租赁时段、设备计量、停机与替换关系分别版本化，记录一经接收不得原地改写；
 * - 每段费用按服务发生时的资格与规则拆分，经机构财务确认后在封账时入账；
 * - 资助方按优先级承担费用，任何一方不得突破其月度额度；
 * - 争议只冻结对应分录，老人已获得的服务事实（计量记录）不回滚；
 * - 换机保留原租赁连续性；同一设备的重叠计量与并发占用一律拒绝；
 * - 迟到回执只调整未封账周期，已封账周期以追加差额分录并注明原因的方式处理；
 * - 引擎状态完全由事件日志重放得到，服务恢复后可继续未完成的封账与退款。
 */
import {
  hoursBetween,
  isoOfMs,
  monthEndMs,
  overlaps,
  parseLocal,
  periodOfIso,
  periodOfMs,
  splitByMonth,
  subtractIntervals,
} from "./timeutil.js";
import { allocateAmount } from "./split.js";

/** 所有资助方额度都耗尽后，剩余费用进入的未覆盖桶（最终由家庭另行处理）。 */
export const UNCOVERED_FUNDER = "UNCOVERED";

function fail(message) {
  throw new Error(message);
}

function ensure(condition, message) {
  if (!condition) fail(message);
}

function groupBy(list, keyFn) {
  const map = new Map();
  for (const item of list) {
    const key = keyFn(item);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(item);
  }
  return map;
}

function freshState() {
  return {
    funders: new Map(), // funder_id -> {funder_id, name, kind, priority}
    eligibility: new Map(), // recipient_id -> Map(funder_id -> [EligibilityRecord])
    packages: new Map(), // package_id -> [ServicePackageRecord]
    agreements: new Map(), // agreement_id -> RentalAgreement
    usages: new Map(), // usage_id -> UsageRecord
    downtimes: [], // [{device_id, from, to, reason}]
    entries: new Map(), // entry_id -> ChargeEntry
    periods: new Map(), // "recipient|period" -> StatementPeriod
    disputes: new Map(), // dispute_id -> DisputeCase
    refunds: new Map(), // refund_id -> RefundObligation
    aggVersions: new Map(), // "aggregate_type:aggregate_id" -> 已用版本号
    entrySeq: 0,
    refundSeq: 0,
  };
}

/**
 * 创建结算引擎。可选 now 返回 ISO 时间字符串，作为事件默认发生时间与"当前账期"的依据。
 */
export function createEngine(options = {}) {
  const now = options.now ?? (() => new Date().toISOString());
  const state = freshState();
  const journal = [];
  let eventSeq = 0;

  // ---------- 事件应用：命令路径与日志回放共用，保证恢复后状态一致 ----------

  function applyEvent(event) {
    const key = `${event.aggregate_type}:${event.aggregate_id}`;
    state.aggVersions.set(key, Math.max(state.aggVersions.get(key) ?? 0, event.version));
    const p = event.payload ?? {};
    switch (event.event_type) {
      case "FUNDER_REGISTERED":
        state.funders.set(p.funder_id, { funder_id: p.funder_id, name: p.name, kind: p.kind, priority: p.priority });
        break;
      case "ELIGIBILITY_ASSESSED": {
        let byFunder = state.eligibility.get(p.recipient_id);
        if (!byFunder) {
          byFunder = new Map();
          state.eligibility.set(p.recipient_id, byFunder);
        }
        let versions = byFunder.get(p.funder_id);
        if (!versions) {
          versions = [];
          byFunder.set(p.funder_id, versions);
        }
        versions.push(p.record);
        versions.sort((a, b) => parseLocal(a.effective_from) - parseLocal(b.effective_from));
        break;
      }
      case "SERVICE_PACKAGE_REGISTERED": {
        let versions = state.packages.get(p.package_id);
        if (!versions) {
          versions = [];
          state.packages.set(p.package_id, versions);
        }
        versions.push(p.record);
        versions.sort((a, b) => parseLocal(a.effective_from) - parseLocal(b.effective_from));
        break;
      }
      case "RENTAL_OPENED":
        state.agreements.set(p.agreement_id, {
          agreement_id: p.agreement_id,
          household_id: p.household_id,
          recipient_id: p.recipient_id,
          opened_at: p.opened_at,
          assignments: [],
        });
        break;
      case "DEVICE_DELIVERED":
        state.agreements.get(p.agreement_id).assignments.push({ device_id: p.device_id, from: p.from, to: null });
        break;
      case "DEVICE_REPLACED": {
        const agg = state.agreements.get(p.agreement_id);
        const current = agg.assignments.find((a) => a.device_id === p.old_device_id && a.to === null);
        if (current) current.to = p.replaced_at;
        agg.assignments.push({ device_id: p.new_device_id, from: p.replaced_at, to: null });
        break;
      }
      case "DOWNTIME_RECORDED":
        state.downtimes.push({ device_id: p.device_id, from: p.from, to: p.to, reason: p.reason });
        break;
      case "USAGE_RECORDED":
        state.usages.set(p.usage.usage_id, p.usage);
        break;
      case "CHARGE_ENTRIES_DRAFTED":
      case "ADJUSTMENT_APPENDED":
        for (const entry of p.entries) {
          state.entries.set(entry.entry_id, entry);
          state.entrySeq = Math.max(state.entrySeq, entry.seq);
        }
        break;
      case "CHARGES_CONFIRMED":
        for (const id of p.entry_ids) {
          const entry = state.entries.get(id);
          if (entry && entry.status === "draft") entry.status = "confirmed";
        }
        break;
      case "PERIOD_CLOSING_STARTED":
        ensurePeriod(p.recipient_id, p.period).status = "closing";
        break;
      case "CHARGE_ENTRIES_POSTED":
        for (const id of p.entry_ids) {
          const entry = state.entries.get(id);
          if (entry && entry.status === "confirmed") entry.status = "posted";
        }
        break;
      case "PERIOD_CLOSED": {
        const period = ensurePeriod(p.recipient_id, p.period);
        period.status = "closed";
        period.totals = p.totals;
        break;
      }
      case "DISPUTE_RAISED": {
        state.disputes.set(p.dispute_id, {
          dispute_id: p.dispute_id,
          entry_ids: [...p.entry_ids],
          reason: p.reason,
          raised_by: p.raised_by,
          status: "open",
          resolution: null,
        });
        for (const [id, prev] of Object.entries(p.prev_status)) {
          const entry = state.entries.get(id);
          if (entry && entry.status !== "reversed") {
            entry.prev_status = prev;
            entry.status = "frozen";
          }
        }
        break;
      }
      case "DISPUTE_RESOLVED": {
        const dispute = state.disputes.get(p.dispute_id);
        if (dispute) {
          dispute.status = "resolved";
          dispute.resolution = { mode: p.mode, reason: p.reason };
        }
        for (const change of p.status_changes) {
          const entry = state.entries.get(change.entry_id);
          if (entry) entry.status = change.to;
        }
        break;
      }
      case "REFUND_REQUESTED":
        state.refunds.set(p.refund.refund_id, p.refund);
        state.refundSeq = Math.max(state.refundSeq, Number(p.refund.refund_id.replace("ref-", "")) || 0);
        break;
      case "REFUND_PAID": {
        const refund = state.refunds.get(p.refund_id);
        if (refund) refund.status = "paid";
        break;
      }
      default:
        break; // 回放时忽略未知事件类型，保持向前兼容
    }
    journal.push(event);
    eventSeq = Math.max(eventSeq, Number(String(event.event_id).replace("evt-", "")) || 0);
  }

  function emit(event_type, aggregate_type, aggregate_id, summary, payload, at) {
    const key = `${aggregate_type}:${aggregate_id}`;
    const version = (state.aggVersions.get(key) ?? 0) + 1;
    const event = {
      event_id: `evt-${String(eventSeq + 1).padStart(6, "0")}`,
      event_type,
      aggregate_type,
      aggregate_id,
      occurred_at: at ?? now(),
      version,
      summary,
      payload,
    };
    applyEvent(event);
    return event;
  }

  // ---------- 派生查询 ----------

  function ensurePeriod(recipient_id, period) {
    const key = `${recipient_id}|${period}`;
    let record = state.periods.get(key);
    if (!record) {
      record = { recipient_id, period, status: "open", totals: null };
      state.periods.set(key, record);
    }
    return record;
  }

  function getPeriodStatus(recipient_id, period) {
    return state.periods.get(`${recipient_id}|${period}`)?.status ?? "open";
  }

  /** 服务发生时刻生效的资格版本。 */
  function eligibilityAt(recipient_id, funder_id, atMs) {
    const versions = state.eligibility.get(recipient_id)?.get(funder_id) ?? [];
    let hit = null;
    for (const v of versions) {
      const from = parseLocal(v.effective_from);
      const to = v.effective_to ? parseLocal(v.effective_to) : null;
      if (from <= atMs && (to === null || atMs < to)) hit = v;
    }
    return hit;
  }

  /** 服务发生时刻生效的服务包版本。 */
  function packageAt(package_id, atMs) {
    const versions = state.packages.get(package_id) ?? [];
    let hit = null;
    for (const v of versions) {
      const from = parseLocal(v.effective_from);
      const to = v.effective_to ? parseLocal(v.effective_to) : null;
      if (from <= atMs && (to === null || atMs < to)) hit = v;
    }
    return hit;
  }

  /** 某资助方在某服务账期内已被占用的额度（分）。冻结分录仍占额度，被冲销的不占。 */
  function usedCapCents(recipient_id, funder_id, service_period) {
    let sum = 0;
    for (const e of state.entries.values()) {
      if (
        e.recipient_id === recipient_id &&
        e.funder_id === funder_id &&
        e.service_period === service_period &&
        e.status !== "reversed"
      ) {
        sum += e.amount_cents;
      }
    }
    return sum;
  }

  function capAt(recipient_id, funder_id, atMs) {
    if (funder_id === UNCOVERED_FUNDER) return null;
    return eligibilityAt(recipient_id, funder_id, atMs)?.monthly_cap_cents ?? null;
  }

  /**
   * 决定分录落在哪个账期：服务所属周期未封账则就地入账；
   * 已封账则追加到当前未封账周期（差额分录，保留原服务周期用于额度核算）。
   */
  function bookingFor(recipient_id, service_period) {
    if (getPeriodStatus(recipient_id, service_period) !== "closed") return service_period;
    const current = periodOfIso(now());
    ensure(
      getPeriodStatus(recipient_id, current) !== "closed",
      `服务周期 ${service_period} 与当前周期 ${current} 均已封账，无法追加差额`,
    );
    return current;
  }

  function buildEntries(list) {
    return list.map((fields) => {
      state.entrySeq += 1;
      return { entry_id: `ent-${String(state.entrySeq).padStart(6, "0")}`, prev_status: null, ...fields, seq: state.entrySeq };
    });
  }

  function emitEntries(entries, at) {
    if (entries.length === 0) return;
    const built = buildEntries(entries);
    for (const list of groupBy(built, (e) => `${e.recipient_id}|${e.booking_period}|${e.kind}`).values()) {
      const first = list[0];
      const type = first.kind === "charge" ? "CHARGE_ENTRIES_DRAFTED" : "ADJUSTMENT_APPENDED";
      const summary = first.kind === "charge" ? `按服务发生时规则拆分费用分录 ${list.length} 条` : `追加差额分录 ${list.length} 条`;
      emit(type, "funding_statement", `${first.recipient_id}:${first.booking_period}`, summary, { entries: list }, at);
    }
  }

  /** 按服务发生时的资格与服务包规则，把金额瀑布式拆给各资助方。 */
  function allocateFor(recipient_id, service_code, atMs, service_period, gross, pkg) {
    const funders = [...state.funders.values()].sort((a, b) => a.priority - b.priority);
    const eligible = [];
    for (const f of funders) {
      const elig = eligibilityAt(recipient_id, f.funder_id, atMs);
      if (!elig || !elig.covered_services.includes(service_code)) continue;
      const coverage = pkg.coverage[f.funder_id] ?? [];
      if (!coverage.includes(service_code)) continue;
      eligible.push({
        funder_id: f.funder_id,
        remaining_cents: elig.monthly_cap_cents - usedCapCents(recipient_id, f.funder_id, service_period),
      });
    }
    const { allocations, uncovered_cents } = allocateAmount(gross, eligible);
    if (uncovered_cents > 0) allocations.push({ funder_id: UNCOVERED_FUNDER, amount_cents: uncovered_cents });
    return allocations;
  }

  function netByFunderForPiece(usage_id, piece_index) {
    const net = new Map();
    for (const e of state.entries.values()) {
      if (e.usage_id === usage_id && e.piece_index === piece_index && e.status !== "reversed") {
        net.set(e.funder_id, (net.get(e.funder_id) ?? 0) + e.amount_cents);
      }
    }
    return net;
  }

  function requireRole(principal, role, message) {
    ensure(principal && principal.role === role, message);
  }

  // ---------- 参考数据命令（分别版本化） ----------

  function registerFunder(cmd, at) {
    ensure(!state.funders.has(cmd.funder_id), `资助方已存在：${cmd.funder_id}`);
    ensure(Number.isInteger(cmd.priority), "资助方优先级必须是整数");
    emit("FUNDER_REGISTERED", "funder_account", cmd.funder_id, `登记资助方 ${cmd.name}`, {
      funder_id: cmd.funder_id,
      name: cmd.name,
      kind: cmd.kind,
      priority: cmd.priority,
    }, at);
  }

  function assessEligibility(cmd, at) {
    ensure(Number.isInteger(cmd.monthly_cap_cents) && cmd.monthly_cap_cents >= 0, "月度额度必须是非负整数（分）");
    ensure(Array.isArray(cmd.covered_services) && cmd.covered_services.length > 0, "适用服务列表不能为空");
    if (cmd.effective_to) ensure(parseLocal(cmd.effective_to) > parseLocal(cmd.effective_from), "资格生效区间不合法");
    const record = {
      effective_from: cmd.effective_from,
      effective_to: cmd.effective_to ?? null,
      monthly_cap_cents: cmd.monthly_cap_cents,
      covered_services: [...cmd.covered_services],
      decided_by: cmd.decided_by ?? "资格评估员",
    };
    emit("ELIGIBILITY_ASSESSED", "care_recipient", cmd.recipient_id, `登记资格决定（${cmd.funder_id}）`, {
      recipient_id: cmd.recipient_id,
      funder_id: cmd.funder_id,
      record,
    }, at);
  }

  function registerServicePackage(cmd, at) {
    for (const [code, price] of Object.entries(cmd.items)) {
      ensure(Number.isInteger(price) && price >= 0, `服务项 ${code} 单价必须是非负整数（分/小时）`);
    }
    const record = {
      effective_from: cmd.effective_from,
      effective_to: cmd.effective_to ?? null,
      items: { ...cmd.items },
      coverage: Object.fromEntries(Object.entries(cmd.coverage).map(([k, v]) => [k, [...v]])),
    };
    emit("SERVICE_PACKAGE_REGISTERED", "service_package", cmd.package_id, `登记服务包 ${cmd.package_id}`, {
      package_id: cmd.package_id,
      record,
    }, at);
  }

  function openRental(cmd, at) {
    ensure(!state.agreements.has(cmd.agreement_id), `租约已存在：${cmd.agreement_id}`);
    emit("RENTAL_OPENED", "rental_agreement", cmd.agreement_id, `开立租约 ${cmd.agreement_id}`, {
      agreement_id: cmd.agreement_id,
      household_id: cmd.household_id,
      recipient_id: cmd.recipient_id,
      opened_at: cmd.from,
    }, at);
    emit("DEVICE_DELIVERED", "rental_agreement", cmd.agreement_id, `交付设备 ${cmd.device_id}`, {
      agreement_id: cmd.agreement_id,
      device_id: cmd.device_id,
      from: cmd.from,
    }, at);
  }

  /** 临时换机：结束旧设备分配、接入新设备，租约本身不变，租赁连续性保留。 */
  function replaceDevice(cmd, at) {
    const agg = state.agreements.get(cmd.agreement_id);
    ensure(agg, `租约不存在：${cmd.agreement_id}`);
    const current = agg.assignments.find((a) => a.to === null);
    ensure(current, `租约 ${cmd.agreement_id} 没有在役设备`);
    ensure(current.device_id !== cmd.new_device_id, "新设备不能与在役设备相同");
    const replacedAtMs = parseLocal(cmd.replaced_at);
    ensure(replacedAtMs >= parseLocal(current.from), "换机时间不能早于设备分配时间");
    for (const u of state.usages.values()) {
      if (u.device_id === current.device_id && parseLocal(u.end) > replacedAtMs) {
        fail(`设备 ${current.device_id} 存在换机时点后的计量 ${u.usage_id}，请先处理再换机`);
      }
    }
    emit("DEVICE_REPLACED", "rental_agreement", cmd.agreement_id, `临时换机：${current.device_id} → ${cmd.new_device_id}`, {
      agreement_id: cmd.agreement_id,
      old_device_id: current.device_id,
      new_device_id: cmd.new_device_id,
      replaced_at: cmd.replaced_at,
      reason: cmd.reason ?? "设备故障临时替换",
    }, at);
  }

  // ---------- 计量与停机 ----------

  function recordUsage(cmd, at) {
    const agg = state.agreements.get(cmd.agreement_id);
    ensure(agg, `租约不存在：${cmd.agreement_id}`);
    ensure(!state.usages.has(cmd.usage_id), `计量记录已存在：${cmd.usage_id}`);
    const start = parseLocal(cmd.start);
    const end = parseLocal(cmd.end);
    ensure(end > start, "计量结束时间必须晚于开始时间");
    const covered = agg.assignments.some(
      (a) => a.device_id === cmd.device_id && parseLocal(a.from) <= start && (a.to === null || end <= parseLocal(a.to)),
    );
    ensure(covered, `设备 ${cmd.device_id} 在该时段未分配给租约 ${cmd.agreement_id}，换机后请使用在役设备计量`);
    for (const u of state.usages.values()) {
      if (u.device_id === cmd.device_id && overlaps(start, end, parseLocal(u.start), parseLocal(u.end))) {
        fail(`设备 ${cmd.device_id} 的计量时段与 ${u.usage_id} 重叠，同一设备不允许重叠计量或并发占用`);
      }
    }
    const cuts = state.downtimes
      .filter((d) => d.device_id === cmd.device_id)
      .map((d) => [parseLocal(d.from), parseLocal(d.to)]);
    const billable = subtractIntervals([[start, end]], cuts);
    const pieces = [];
    const entries = [];
    for (const [s, e] of billable) {
      for (const [ps, pe] of splitByMonth(s, e)) {
        const pkg = packageAt(cmd.package_id, ps);
        ensure(pkg, `服务发生时无有效服务包：${cmd.package_id}`);
        const price = pkg.items[cmd.service_code];
        ensure(Number.isInteger(price), `服务包 ${cmd.package_id} 不含服务项：${cmd.service_code}`);
        const gross = Math.round(hoursBetween(ps, pe) * price);
        const service_period = periodOfMs(ps);
        const piece = { start: isoOfMs(ps), end: isoOfMs(pe), service_period, gross_cents: gross, price_cents_per_hour: price };
        pieces.push(piece);
        if (gross <= 0) continue;
        const pieceIndex = pieces.length - 1;
        const booking = bookingFor(agg.recipient_id, service_period);
        const late = booking !== service_period;
        const reason = late ? `迟到回执补登：服务发生在已封账周期 ${service_period}` : null;
        for (const alloc of allocateFor(agg.recipient_id, cmd.service_code, ps, service_period, gross, pkg)) {
          entries.push({
            recipient_id: agg.recipient_id,
            household_id: agg.household_id,
            agreement_id: agg.agreement_id,
            usage_id: cmd.usage_id,
            piece_index: pieceIndex,
            service_code: cmd.service_code,
            funder_id: alloc.funder_id,
            kind: late ? "adjustment" : "charge",
            reason,
            booking_period: booking,
            service_period,
            service_start: piece.start,
            service_end: piece.end,
            billable_hours: hoursBetween(ps, pe),
            amount_cents: alloc.amount_cents,
            status: "draft",
          });
        }
      }
    }
    const usage = {
      usage_id: cmd.usage_id,
      agreement_id: cmd.agreement_id,
      device_id: cmd.device_id,
      service_code: cmd.service_code,
      package_id: cmd.package_id,
      start: cmd.start,
      end: cmd.end,
      pieces,
      status: "active",
      recorded_at: at ?? now(),
    };
    emit("USAGE_RECORDED", "robot_device", cmd.device_id, `记录设备 ${cmd.device_id} 使用计量 ${cmd.usage_id}`, { usage }, at);
    emitEntries(entries, at);
    return usage;
  }

  /**
   * 登记停机。停机时段不计费：之后的计量直接扣除；
   * 对已计量的费用，按资助方优先级逆序（未覆盖桶最先）冲减，生成差额分录。
   */
  function recordDowntime(cmd, at) {
    const from = parseLocal(cmd.from);
    const to = parseLocal(cmd.to);
    ensure(to > from, "停机结束时间必须晚于开始时间");
    const reason = cmd.reason ?? "设备停机";
    emit("DOWNTIME_RECORDED", "robot_device", cmd.device_id, `登记设备 ${cmd.device_id} 停机`, {
      device_id: cmd.device_id,
      from: cmd.from,
      to: cmd.to,
      reason,
    }, at);
    const adjustments = [];
    for (const u of state.usages.values()) {
      if (u.device_id !== cmd.device_id || u.status !== "active") continue;
      const agg = state.agreements.get(u.agreement_id);
      u.pieces.forEach((piece, pieceIndex) => {
        const ps = parseLocal(piece.start);
        const pe = parseLocal(piece.end);
        if (!overlaps(ps, pe, from, to)) return;
        const overlapMs = Math.min(pe, to) - Math.max(ps, from);
        let delta = Math.round((overlapMs / 3600000) * piece.price_cents_per_hour);
        if (delta <= 0) return;
        const net = netByFunderForPiece(u.usage_id, pieceIndex);
        const totalNet = [...net.values()].reduce((a, b) => a + b, 0);
        delta = Math.min(delta, totalNet);
        const order = [
          UNCOVERED_FUNDER,
          ...[...state.funders.values()].sort((a, b) => b.priority - a.priority).map((f) => f.funder_id),
        ];
        for (const funderId of order) {
          if (delta <= 0) break;
          const take = Math.min(net.get(funderId) ?? 0, delta);
          if (take <= 0) continue;
          delta -= take;
          adjustments.push({
            recipient_id: agg.recipient_id,
            household_id: agg.household_id,
            agreement_id: agg.agreement_id,
            usage_id: u.usage_id,
            piece_index: pieceIndex,
            service_code: u.service_code,
            funder_id: funderId,
            kind: "adjustment",
            reason: `停机冲减：${reason}`,
            booking_period: bookingFor(agg.recipient_id, piece.service_period),
            service_period: piece.service_period,
            service_start: null,
            service_end: null,
            billable_hours: null,
            amount_cents: -take,
            status: "draft",
          });
        }
      });
    }
    emitEntries(adjustments, at);
  }

  // ---------- 财务确认与封账 ----------

  function confirmCharges(cmd, at) {
    requireRole(cmd.principal, "finance", "仅机构财务可确认分录");
    const drafts = [...state.entries.values()].filter(
      (e) => e.recipient_id === cmd.recipient_id && e.booking_period === cmd.period && e.status === "draft",
    );
    ensure(drafts.length > 0, `周期 ${cmd.period} 没有待确认的分录`);
    emit("CHARGES_CONFIRMED", "funding_statement", `${cmd.recipient_id}:${cmd.period}`, `机构财务确认分录 ${drafts.length} 条`, {
      entry_ids: drafts.map((e) => e.entry_id),
      confirmed_by: cmd.confirmed_by ?? "机构财务",
    }, at);
  }

  function beginPeriodClose(cmd, at) {
    const status = getPeriodStatus(cmd.recipient_id, cmd.period);
    ensure(status === "open", `周期 ${cmd.period} 已在封账流程中或已封账`);
    emit("PERIOD_CLOSING_STARTED", "funding_statement", `${cmd.recipient_id}:${cmd.period}`, `开始封账 ${cmd.period}`, {
      recipient_id: cmd.recipient_id,
      period: cmd.period,
    }, at);
  }

  function closePeriod(cmd, at) {
    requireRole(cmd.principal, "finance", "仅机构财务可执行封账");
    const status = getPeriodStatus(cmd.recipient_id, cmd.period);
    ensure(status !== "closed", `周期 ${cmd.period} 已封账，不得重复封账`);
    const drafts = [...state.entries.values()].filter(
      (e) => e.recipient_id === cmd.recipient_id && e.booking_period === cmd.period && e.status === "draft",
    );
    ensure(drafts.length === 0, `周期 ${cmd.period} 存在 ${drafts.length} 条未确认分录，须由机构财务确认后方可封账`);
    if (status === "open") beginPeriodClose(cmd, at);
    finishClose(cmd.recipient_id, cmd.period, cmd.closed_by ?? "机构财务", at);
  }

  /** 封账收尾：确认分录入账、汇总、为负净额资助方生成退款义务。可重复执行，已入账分录不会重复入账。 */
  function finishClose(recipient_id, period, closed_by, at) {
    const confirmed = [...state.entries.values()].filter(
      (e) => e.recipient_id === recipient_id && e.booking_period === period && e.status === "confirmed",
    );
    if (confirmed.length > 0) {
      emit("CHARGE_ENTRIES_POSTED", "funding_statement", `${recipient_id}:${period}`, `入账分录 ${confirmed.length} 条`, {
        entry_ids: confirmed.map((e) => e.entry_id),
      }, at);
    }
    const posted = [...state.entries.values()].filter(
      (e) => e.recipient_id === recipient_id && e.booking_period === period && e.status === "posted",
    );
    const totals = {};
    for (const e of posted) totals[e.funder_id] = (totals[e.funder_id] ?? 0) + e.amount_cents;
    emit("PERIOD_CLOSED", "funding_statement", `${recipient_id}:${period}`, `周期 ${period} 封账完成`, {
      recipient_id,
      period,
      totals,
      closed_by,
    }, at);
    for (const [funder_id, total] of Object.entries(totals)) {
      if (total < 0) {
        state.refundSeq += 1;
        const refund = {
          refund_id: `ref-${String(state.refundSeq).padStart(6, "0")}`,
          recipient_id,
          funder_id,
          amount_cents: -total,
          booking_period: period,
          reason: `周期 ${period} 封账净额为负，退回相应资助方`,
          status: "pending",
        };
        emit("REFUND_REQUESTED", "refund_obligation", refund.refund_id, `生成退款义务 ${refund.refund_id}`, { refund }, at);
      }
    }
  }

  /** 服务恢复后的续作：完成所有未完成的封账，再支付所有待支付退款。幂等，可重复调用。 */
  function resumePending(at) {
    for (const p of [...state.periods.values()]) {
      if (p.status === "closing") finishClose(p.recipient_id, p.period, "系统恢复续作", at);
    }
    processRefunds(at);
  }

  function processRefunds(at) {
    for (const r of [...state.refunds.values()]) {
      if (r.status === "pending") {
        emit("REFUND_PAID", "refund_obligation", r.refund_id, `支付退款 ${r.refund_id}`, { refund_id: r.refund_id }, at);
      }
    }
  }

  // ---------- 争议 ----------

  /** 冻结指定分录；只影响这些分录，同周期其余分录照常确认与封账，计量事实不受影响。 */
  function raiseDispute(cmd, at) {
    ensure(!state.disputes.has(cmd.dispute_id), `争议单已存在：${cmd.dispute_id}`);
    const prev_status = {};
    for (const id of cmd.entry_ids) {
      const entry = state.entries.get(id);
      ensure(entry, `分录不存在：${id}`);
      ensure(
        entry.status === "draft" || entry.status === "confirmed" || entry.status === "posted",
        `分录 ${id} 当前状态 ${entry.status} 不能冻结`,
      );
      prev_status[id] = entry.status;
    }
    emit("DISPUTE_RAISED", "dispute_case", cmd.dispute_id, `冻结分录 ${cmd.entry_ids.length} 条`, {
      dispute_id: cmd.dispute_id,
      entry_ids: [...cmd.entry_ids],
      reason: cmd.reason,
      raised_by: cmd.raised_by ?? "机构",
      prev_status,
    }, at);
  }

  /**
   * 处理争议。release 解除冻结：周期未封账则恢复原状态，已封账则在当前周期补登差额；
   * uphold 争议成立：未入账的直接冲销，已入账的保留历史并在当前周期生成等额负向差额。
   */
  function resolveDispute(cmd, at) {
    const dispute = state.disputes.get(cmd.dispute_id);
    ensure(dispute, `争议单不存在：${cmd.dispute_id}`);
    ensure(dispute.status === "open", `争议单 ${cmd.dispute_id} 已处理`);
    ensure(cmd.mode === "release" || cmd.mode === "uphold", "争议处理方式必须是 release（解除）或 uphold（成立）");
    const status_changes = [];
    const newEntries = [];
    for (const id of dispute.entry_ids) {
      const entry = state.entries.get(id);
      if (!entry || entry.status !== "frozen") continue;
      const periodClosed = getPeriodStatus(entry.recipient_id, entry.booking_period) === "closed";
      if (cmd.mode === "release" && !periodClosed) {
        status_changes.push({ entry_id: id, to: entry.prev_status ?? "draft" });
      } else if (cmd.mode === "release" && periodClosed) {
        status_changes.push({ entry_id: id, to: "reversed" });
        newEntries.push({
          recipient_id: entry.recipient_id,
          household_id: entry.household_id,
          agreement_id: entry.agreement_id,
          usage_id: entry.usage_id,
          piece_index: entry.piece_index,
          service_code: entry.service_code,
          funder_id: entry.funder_id,
          kind: "adjustment",
          reason: `争议解除补登：${cmd.reason ?? dispute.reason}`,
          booking_period: bookingFor(entry.recipient_id, entry.service_period),
          service_period: entry.service_period,
          service_start: entry.service_start,
          service_end: entry.service_end,
          billable_hours: entry.billable_hours,
          amount_cents: entry.amount_cents,
          status: "draft",
        });
      } else {
        // uphold：争议成立。已入账分录保留在原封账周期作为历史（不得改写），
        // 另在当前周期生成等额负向差额冲销；未入账的直接冲销原分录即可。
        if (entry.prev_status === "posted") {
          status_changes.push({ entry_id: id, to: "posted" });
          newEntries.push({
            recipient_id: entry.recipient_id,
            household_id: entry.household_id,
            agreement_id: entry.agreement_id,
            usage_id: entry.usage_id,
            piece_index: entry.piece_index,
            service_code: entry.service_code,
            funder_id: entry.funder_id,
            kind: "adjustment",
            reason: `争议成立冲销：${cmd.reason ?? dispute.reason}`,
            booking_period: bookingFor(entry.recipient_id, entry.service_period),
            service_period: entry.service_period,
            service_start: null,
            service_end: null,
            billable_hours: null,
            amount_cents: -entry.amount_cents,
            status: "draft",
          });
        } else {
          status_changes.push({ entry_id: id, to: "reversed" });
        }
      }
    }
    emit("DISPUTE_RESOLVED", "dispute_case", cmd.dispute_id, `争议处理：${cmd.mode === "release" ? "解除冻结" : "争议成立"}`, {
      dispute_id: cmd.dispute_id,
      mode: cmd.mode,
      reason: cmd.reason ?? null,
      status_changes,
    }, at);
    emitEntries(newEntries, at);
  }

  // ---------- 视图（按角色隔离） ----------

  /** 家庭视图：仅本户明细。 */
  function familyStatement(principal, household_id, period) {
    requireRole(principal, "family", "仅家庭角色可查看家庭账单");
    ensure(principal.household_id === household_id, "家庭只能查看本户明细");
    const entries = [...state.entries.values()].filter(
      (e) => e.household_id === household_id && e.booking_period === period && e.status !== "reversed",
    );
    const lines = [];
    for (const list of groupBy(entries.filter((e) => e.usage_id), (e) => `${e.usage_id}#${e.piece_index}`).values()) {
      const first = list[0];
      lines.push({
        usage_id: first.usage_id,
        service_code: first.service_code,
        service_start: first.service_start,
        service_end: first.service_end,
        billable_hours: first.billable_hours,
        splits: list.map((e) => ({
          entry_id: e.entry_id,
          funder_id: e.funder_id,
          amount_cents: e.amount_cents,
          kind: e.kind,
          reason: e.reason,
          status: e.status,
        })),
      });
    }
    const totals_by_funder = {};
    let frozen_cents = 0;
    for (const e of entries) {
      totals_by_funder[e.funder_id] = (totals_by_funder[e.funder_id] ?? 0) + e.amount_cents;
      if (e.status === "frozen") frozen_cents += e.amount_cents;
    }
    const familyFunderIds = new Set([...state.funders.values()].filter((f) => f.kind === "family_self_pay").map((f) => f.funder_id));
    let family_payable_cents = 0;
    for (const [funder_id, total] of Object.entries(totals_by_funder)) {
      if (familyFunderIds.has(funder_id) || funder_id === UNCOVERED_FUNDER) family_payable_cents += total;
    }
    return { household_id, period, lines, totals_by_funder, family_payable_cents, frozen_cents };
  }

  /** 资助方视图：仅自身承担的汇总，不含服务明细、不含其他资助方。 */
  function funderSummary(principal, funder_id, period) {
    requireRole(principal, "funder", "仅资助方角色可查看资助汇总");
    ensure(principal.funder_id === funder_id, "资助方只能查看自身承担的汇总");
    const entries = [...state.entries.values()].filter(
      (e) => e.funder_id === funder_id && e.booking_period === period && e.status !== "reversed",
    );
    const byServicePeriod = {};
    let total = 0;
    for (const e of entries) {
      byServicePeriod[e.service_period] = (byServicePeriod[e.service_period] ?? 0) + e.amount_cents;
      total += e.amount_cents;
    }
    return {
      funder_id,
      period,
      total_cents: total,
      entry_count: entries.length,
      by_service_period: Object.entries(byServicePeriod).map(([service_period, total_cents]) => ({ service_period, total_cents })),
    };
  }

  /** 审计视图：每一小时由谁支付，以及各资助方剩余额度如何变化。 */
  function auditTrail(principal, recipient_id, service_period) {
    requireRole(principal, "audit", "仅审计角色可查看审计视图");
    const entries = [...state.entries.values()]
      .filter((e) => e.recipient_id === recipient_id && e.service_period === service_period && e.status !== "reversed")
      .sort((a, b) => a.seq - b.seq);
    const running = new Map();
    const entryLines = entries.map((e) => {
      const usedBefore = running.get(e.funder_id) ?? 0;
      running.set(e.funder_id, usedBefore + e.amount_cents);
      const cap = capAt(recipient_id, e.funder_id, e.service_start ? parseLocal(e.service_start) : monthEndMs(e.service_period) - 1);
      return {
        entry_id: e.entry_id,
        usage_id: e.usage_id,
        service_code: e.service_code,
        funder_id: e.funder_id,
        kind: e.kind,
        reason: e.reason,
        status: e.status,
        service_start: e.service_start,
        service_end: e.service_end,
        billable_hours: e.billable_hours,
        amount_cents: e.amount_cents,
        booking_period: e.booking_period,
        cap_cents: cap,
        used_before_cents: usedBefore,
        used_after_cents: usedBefore + e.amount_cents,
        remaining_after_cents: cap === null ? null : cap - usedBefore - e.amount_cents,
      };
    });
    const hourly = [];
    for (const u of state.usages.values()) {
      const agg = state.agreements.get(u.agreement_id);
      if (!agg || agg.recipient_id !== recipient_id) continue;
      u.pieces.forEach((piece, idx) => {
        if (piece.service_period !== service_period) return;
        const payers = [];
        for (const e of state.entries.values()) {
          if (e.usage_id === u.usage_id && e.piece_index === idx && e.status !== "reversed") {
            payers.push({ funder_id: e.funder_id, amount_cents: e.amount_cents, status: e.status });
          }
        }
        hourly.push({
          usage_id: u.usage_id,
          device_id: u.device_id,
          service_code: u.service_code,
          start: piece.start,
          end: piece.end,
          gross_cents: piece.gross_cents,
          payers,
        });
      });
    }
    return { recipient_id, service_period, entries: entryLines, hourly, remaining_caps: remainingCaps(recipient_id, service_period) };
  }

  // ---------- 只读查询 ----------

  function remainingCaps(recipient_id, service_period) {
    const byFunder = state.eligibility.get(recipient_id);
    if (!byFunder) return [];
    const result = [];
    for (const funder_id of byFunder.keys()) {
      const cap = capAt(recipient_id, funder_id, monthEndMs(service_period) - 1);
      if (cap === null) continue;
      const used = usedCapCents(recipient_id, funder_id, service_period);
      result.push({ funder_id, cap_cents: cap, used_cents: used, remaining_cents: cap - used });
    }
    return result;
  }

  function getRentalTimeline(agreement_id) {
    const agg = state.agreements.get(agreement_id);
    ensure(agg, `租约不存在：${agreement_id}`);
    return structuredClone(agg);
  }

  function getEligibilityHistory(recipient_id, funder_id) {
    return structuredClone(state.eligibility.get(recipient_id)?.get(funder_id) ?? []);
  }

  function getPackageHistory(package_id) {
    return structuredClone(state.packages.get(package_id) ?? []);
  }

  function getUsage(usage_id) {
    const usage = state.usages.get(usage_id);
    ensure(usage, `计量记录不存在：${usage_id}`);
    return structuredClone(usage);
  }

  function getEntry(entry_id) {
    const entry = state.entries.get(entry_id);
    ensure(entry, `分录不存在：${entry_id}`);
    return structuredClone(entry);
  }

  function listEntries(filter = {}) {
    return [...state.entries.values()]
      .filter((e) => Object.entries(filter).every(([k, v]) => e[k] === v))
      .map((e) => structuredClone(e));
  }

  function listRefunds() {
    return [...state.refunds.values()].map((r) => ({ ...r }));
  }

  function getJournal() {
    return journal.map((e) => structuredClone(e));
  }

  /** 回放事件日志，用于服务恢复。 */
  function load(events) {
    for (const event of events) applyEvent(structuredClone(event));
  }

  return {
    registerFunder,
    assessEligibility,
    registerServicePackage,
    openRental,
    replaceDevice,
    recordUsage,
    recordDowntime,
    confirmCharges,
    beginPeriodClose,
    closePeriod,
    resumePending,
    processRefunds,
    raiseDispute,
    resolveDispute,
    familyStatement,
    funderSummary,
    auditTrail,
    remainingCaps,
    getRentalTimeline,
    getEligibilityHistory,
    getPackageHistory,
    getUsage,
    getEntry,
    listEntries,
    listRefunds,
    getPeriodStatus,
    getJournal,
    load,
  };
}

/** 从事件日志重建引擎（服务恢复入口）。 */
export function replayJournal(events, options = {}) {
  const engine = createEngine(options);
  engine.load(events);
  return engine;
}
