import { EventStore } from "./store.js";
import { fail } from "./errors.js";
import {
  minutesBetween,
  overlapsInterval,
  periodOf,
  toMs,
  unionCoverageMinutes,
} from "./intervals.js";
import { allocateCharges, distributeByWeight } from "./split.js";

/** 计入资助方额度占用的分录类型（退款是资金退回，不重复占用额度）。 */
const CAP_RELEVANT_KINDS = new Set(["charge", "correction", "adjustment"]);

function freshState() {
  return {
    eligibility: new Map(), // household_id → [ {decision_id, effective_from, funders, version} ]
    packages: new Map(), // package_id → [ {effective_from, items, version} ]
    agreements: new Map(), // agreement_id → {household_id, start, end, closed, chain:[{device_id, from, to}]}
    devices: new Set(),
    usages: new Map(), // usage_id → {…}
    deviceUsages: new Map(), // device_id → [usage_id]
    downtimes: new Map(), // device_id → [{downtime_id, start, end, reason}]
    downtimeIds: new Set(),
    entries: new Map(), // entry_id → LedgerEntry
    periods: new Map(), // period → "sealing" | "sealed"（缺省为 open）
    statements: new Map(), // period → 封账时点的资助方合计快照
  };
}

function requireRole(principal, role) {
  if (!principal || principal.role !== role) fail("ACCESS_DENIED", `需要 ${role} 角色才能执行该操作`);
}

/**
 * 养老机器人共享结算台：按实际使用形成资金责任链。
 * 资格决定、租赁时段、服务包、设备计量、停机与替换关系分别按各自聚合版本化；
 * 全部状态由事件重放得到，服务实例崩溃后用同一事件存储重建即可续跑。
 */
export class SettlementService {
  #store;
  #hooks;
  #state;

  constructor(store = new EventStore(), options = {}) {
    this.#store = store;
    this.#hooks = options.hooks ?? {};
    this.#state = freshState();
    for (const event of store.all()) this.#apply(event);
  }

  get store() {
    return this.#store;
  }

  // ---------- 事件追加与投影 ----------

  #emit(record) {
    const event = this.#store.append(record);
    this.#apply(event);
    this.#hooks.afterEvent?.(event);
    return event;
  }

  #apply(event) {
    const s = this.#state;
    const p = event.payload ?? {};
    switch (event.event_type) {
      case "ELIGIBILITY_ASSESSED": {
        const list = s.eligibility.get(event.aggregate_id) ?? [];
        list.push({ decision_id: p.decision_id, effective_from: p.effective_from, funders: p.funders, version: event.version });
        list.sort((a, b) => toMs(a.effective_from) - toMs(b.effective_from) || a.version - b.version);
        s.eligibility.set(event.aggregate_id, list);
        break;
      }
      case "SERVICE_PACKAGE_PUBLISHED": {
        const list = s.packages.get(event.aggregate_id) ?? [];
        list.push({ effective_from: p.effective_from, items: p.items, version: event.version });
        list.sort((a, b) => toMs(a.effective_from) - toMs(b.effective_from) || a.version - b.version);
        s.packages.set(event.aggregate_id, list);
        break;
      }
      case "RENTAL_PERIOD_SCHEDULED":
        s.agreements.set(event.aggregate_id, {
          household_id: p.household_id,
          start: p.start,
          end: p.end,
          closed: false,
          chain: [{ device_id: p.device_id, from: p.start, to: p.end }],
        });
        s.devices.add(p.device_id);
        break;
      case "DEVICE_REPLACED": {
        const ag = s.agreements.get(event.aggregate_id);
        const seg = ag.chain.find(
          (c) => c.device_id === p.from_device_id && toMs(c.from) <= toMs(p.at) && toMs(p.at) < toMs(c.to),
        );
        if (seg) seg.to = p.at;
        ag.chain.push({ device_id: p.to_device_id, from: p.at, to: ag.end });
        ag.chain.sort((a, b) => toMs(a.from) - toMs(b.from));
        s.devices.add(p.to_device_id);
        break;
      }
      case "RENTAL_PERIOD_CLOSED": {
        const ag = s.agreements.get(event.aggregate_id);
        ag.closed = true;
        ag.end = p.end;
        ag.chain = ag.chain
          .map((c) => ({ ...c, to: toMs(c.to) > toMs(p.end) ? p.end : c.to }))
          .filter((c) => toMs(c.from) < toMs(c.to));
        break;
      }
      case "USAGE_RECORDED": {
        s.usages.set(p.usage_id, {
          usage_id: p.usage_id,
          agreement_id: p.agreement_id,
          household_id: p.household_id,
          device_id: event.aggregate_id,
          service_code: p.service_code,
          start: p.start,
          end: p.end,
          minutes: p.minutes,
          billable_minutes: p.billable_minutes,
          amount_cents: p.amount_cents,
        });
        const list = s.deviceUsages.get(event.aggregate_id) ?? [];
        list.push(p.usage_id);
        s.deviceUsages.set(event.aggregate_id, list);
        break;
      }
      case "DOWNTIME_RECORDED": {
        const list = s.downtimes.get(event.aggregate_id) ?? [];
        list.push({ downtime_id: p.downtime_id, start: p.start, end: p.end, reason: p.reason });
        s.downtimes.set(event.aggregate_id, list);
        s.downtimeIds.add(p.downtime_id);
        break;
      }
      case "ENTRY_PROPOSED":
        s.entries.set(p.entry.entry_id, { ...p.entry, status: "proposed", frozen: false, posted_at: null });
        break;
      case "ENTRY_POSTED": {
        const e = s.entries.get(event.aggregate_id);
        e.status = "posted";
        e.posted_at = event.occurred_at;
        break;
      }
      case "ENTRY_DISPUTED": {
        const e = s.entries.get(event.aggregate_id);
        e.frozen = true;
        e.dispute_reason = p.reason;
        break;
      }
      case "ENTRY_DISPUTE_RESOLVED": {
        const e = s.entries.get(event.aggregate_id);
        e.frozen = false;
        break;
      }
      case "PERIOD_SEALING_STARTED":
        s.periods.set(event.aggregate_id, "sealing");
        break;
      case "PERIOD_SEALED":
        s.periods.set(event.aggregate_id, "sealed");
        break;
      case "STATEMENT_SETTLED":
        s.statements.set(p.period, p.totals);
        break;
      case "REFUND_REQUESTED":
        s.entries.set(p.entry.entry_id, {
          ...p.entry,
          status: "posted",
          frozen: false,
          refund_state: "requested",
          posted_at: event.occurred_at,
        });
        break;
      case "REFUND_COMPLETED": {
        const e = s.entries.get(event.aggregate_id);
        e.refund_state = "completed";
        break;
      }
      default:
        break; // 兼容历史事件类型（如 DEVICE_DELIVERED），不改变结算状态
    }
  }

  // ---------- 规则与资格 ----------

  /** 登记资格决定（按户版本化，生效时间决定其适用于哪段服务）。 */
  assessEligibility({ household_id, effective_from, funders, occurred_at, reason, decision_id }) {
    if (!household_id) fail("VALIDATION", "household_id 不能为空");
    toMs(effective_from, "effective_from");
    toMs(occurred_at);
    if (!Array.isArray(funders) || funders.length === 0) fail("ELIGIBILITY_INVALID", "资助方列表不能为空");
    const ids = new Set();
    const priorities = new Set();
    for (const f of funders) {
      if (!f.funder_id || !f.kind) fail("ELIGIBILITY_INVALID", "资助方缺少 funder_id 或 kind");
      if (!Number.isInteger(f.priority)) fail("ELIGIBILITY_INVALID", `资助方 ${f.funder_id} 的 priority 必须是整数`);
      if (f.cap_cents != null) {
        if (!Number.isInteger(f.cap_cents) || f.cap_cents < 0) fail("ELIGIBILITY_INVALID", `资助方 ${f.funder_id} 的 cap_cents 必须是非负整数`);
        if (f.cap_period !== "month" && f.cap_period !== "total") fail("ELIGIBILITY_INVALID", `资助方 ${f.funder_id} 需指定 cap_period（month|total）`);
      }
      if (f.services !== "*" && (!Array.isArray(f.services) || f.services.length === 0)) {
        fail("ELIGIBILITY_INVALID", `资助方 ${f.funder_id} 的 services 必须是 "*" 或非空数组`);
      }
      if (ids.has(f.funder_id)) fail("ELIGIBILITY_INVALID", `资助方重复：${f.funder_id}`);
      if (priorities.has(f.priority)) fail("ELIGIBILITY_INVALID", `资助方优先级重复：${f.priority}`);
      ids.add(f.funder_id);
      priorities.add(f.priority);
    }
    const fallback = funders.some((f) => f.cap_cents == null && f.services === "*");
    if (!fallback) fail("ELIGIBILITY_INVALID", "需保留一个不限额且适用全部服务的兜底资助方（通常为家庭自付）");
    const seq = (this.#state.eligibility.get(household_id) ?? []).length + 1;
    const payload = { decision_id: decision_id ?? `dec:${household_id}:v${seq}`, household_id, effective_from, funders };
    if (reason) payload.reason = reason;
    this.#emit({
      event_type: "ELIGIBILITY_ASSESSED",
      aggregate_type: "care_recipient",
      aggregate_id: household_id,
      occurred_at,
      summary: `登记资格决定：户 ${household_id}，自 ${effective_from} 生效`,
      payload,
    });
    return payload.decision_id;
  }

  /** 发布服务包（按包版本化，价格以服务发生时的有效版本为准）。 */
  publishPackage({ package_id, effective_from, items, occurred_at }) {
    if (!package_id) fail("VALIDATION", "package_id 不能为空");
    toMs(effective_from, "effective_from");
    toMs(occurred_at);
    if (!items || typeof items !== "object" || Object.keys(items).length === 0) fail("VALIDATION", "服务包 items 不能为空");
    for (const [code, item] of Object.entries(items)) {
      if (!Number.isInteger(item.unit_price_cents) || item.unit_price_cents < 0) {
        fail("VALIDATION", `服务 ${code} 的单价必须是非负整数（分/小时）`);
      }
    }
    this.#emit({
      event_type: "SERVICE_PACKAGE_PUBLISHED",
      aggregate_type: "service_package",
      aggregate_id: package_id,
      occurred_at,
      summary: `发布服务包 ${package_id}，自 ${effective_from} 生效`,
      payload: { package_id, effective_from, items },
    });
  }

  // ---------- 租赁与设备 ----------

  /** 安排租赁时段；同一设备在重叠时段内不得被另一协议占用。 */
  scheduleRental({ agreement_id, household_id, device_id, start, end, occurred_at }) {
    if (!agreement_id || !household_id || !device_id) fail("VALIDATION", "agreement_id、household_id、device_id 均不能为空");
    if (this.#state.agreements.has(agreement_id)) fail("AGREEMENT_EXISTS", `租赁协议已存在：${agreement_id}`);
    minutesBetween(start, end);
    toMs(occurred_at);
    this.#assertDeviceFree(device_id, start, end, null);
    this.#emit({
      event_type: "RENTAL_PERIOD_SCHEDULED",
      aggregate_type: "rental_agreement",
      aggregate_id: agreement_id,
      occurred_at,
      summary: `安排租赁：户 ${household_id} 自 ${start} 至 ${end} 租用设备 ${device_id}`,
      payload: { household_id, device_id, start, end },
    });
  }

  /** 临时换机：原协议与租赁时段不变，设备链从 at 起切换到新设备，保留租赁连续性。 */
  replaceDevice({ agreement_id, to_device_id, at, reason, occurred_at }) {
    const ag = this.#agreement(agreement_id);
    if (ag.closed) fail("AGREEMENT_CLOSED", `租赁协议已结束：${agreement_id}`);
    toMs(at, "at");
    if (!(toMs(ag.start) < toMs(at) && toMs(at) < toMs(ag.end))) fail("INVALID_INTERVAL", `换机时间须位于租赁时段内：${at}`);
    const seg = ag.chain.find((c) => toMs(c.from) <= toMs(at) && toMs(at) < toMs(c.to));
    const from_device_id = seg.device_id;
    if (from_device_id === to_device_id) fail("SAME_DEVICE", "换机前后设备相同");
    this.#assertDeviceFree(to_device_id, at, ag.end, agreement_id);
    this.#emit({
      event_type: "DEVICE_REPLACED",
      aggregate_type: "rental_agreement",
      aggregate_id: agreement_id,
      occurred_at,
      summary: `设备换机：${from_device_id} → ${to_device_id}，协议 ${agreement_id} 租赁连续性保留`,
      payload: { from_device_id, to_device_id, at, reason: reason ?? "设备故障" },
    });
    return { from_device_id, to_device_id };
  }

  /** 提前结束租赁（退租），释放 end 之后的设备占用。 */
  closeRental({ agreement_id, end, occurred_at, reason }) {
    const ag = this.#agreement(agreement_id);
    if (ag.closed) fail("AGREEMENT_CLOSED", `租赁协议已结束：${agreement_id}`);
    toMs(end, "end");
    if (toMs(end) <= toMs(ag.start)) fail("INVALID_INTERVAL", `结束时间须晚于开始时间：${end}`);
    if (toMs(end) > toMs(ag.end)) fail("INVALID_INTERVAL", `结束时间不能晚于原租期结束：${end}`);
    this.#emit({
      event_type: "RENTAL_PERIOD_CLOSED",
      aggregate_type: "rental_agreement",
      aggregate_id: agreement_id,
      occurred_at,
      summary: `结束租赁 ${agreement_id}，生效于 ${end}`,
      payload: { end, reason: reason ?? "退租" },
    });
  }

  // ---------- 计量与停机 ----------

  /**
   * 记录一段用量并立即按服务发生时的资格与价格拆分费用（生成待确认分录）。
   * 同一设备的重叠计量必须拒绝；同一 usage_id 不得重复入账。
   */
  recordUsage({ usage_id, agreement_id, device_id, service_code, start, end, occurred_at }) {
    if (!usage_id || !service_code) fail("VALIDATION", "usage_id、service_code 不能为空");
    if (this.#state.usages.has(usage_id)) fail("USAGE_EXISTS", `用量记录已存在：${usage_id}`);
    const ag = this.#agreement(agreement_id);
    const minutes = minutesBetween(start, end);
    toMs(occurred_at);
    const period = periodOf(start);
    if (!this.#isOpen(period)) fail("PERIOD_SEALED", `周期 ${period} 已封账，迟到计量请通过回执或调整流程处理`);
    const seg = ag.chain.find((c) => c.device_id === device_id && toMs(c.from) <= toMs(start) && toMs(end) <= toMs(c.to));
    if (!seg) fail("DEVICE_NOT_ASSIGNED", `设备 ${device_id} 在 ${start}~${end} 未分配给协议 ${agreement_id}`);
    for (const otherId of this.#state.deviceUsages.get(device_id) ?? []) {
      const other = this.#state.usages.get(otherId);
      if (overlapsInterval(other.start, other.end, start, end)) {
        fail("METERING_OVERLAP", `设备 ${device_id} 在 ${other.start}~${other.end} 已有计量记录 ${otherId}，拒绝重叠计量`);
      }
    }
    const price = this.#priceAt(service_code, start);
    if (price == null) fail("NO_PRICE", `服务 ${service_code} 在 ${start} 无有效价格`);
    const downtimeMinutes = unionCoverageMinutes(
      (this.#state.downtimes.get(device_id) ?? []).map((d) => [d.start, d.end]),
      start,
      end,
    );
    const billable = minutes - downtimeMinutes;
    const amount = Math.round((billable * price) / 60);
    const rules = this.#eligibilityAt(ag.household_id, start) ?? [
      { funder_id: `self:${ag.household_id}`, kind: "family_self_pay", priority: 1, cap_cents: null, cap_period: null, services: "*" },
    ];
    const allocations = allocateCharges({
      amount_cents: amount,
      rules,
      usedAmount: (rule) => this.#usedAmount(ag.household_id, rule.funder_id, rule.cap_period, period),
      service_code,
    });
    const entries = allocations.map((a) => ({
      entry_id: `ent:${usage_id}:${a.funder_id}`,
      period,
      household_id: ag.household_id,
      agreement_id,
      usage_id,
      funder_id: a.funder_id,
      funder_kind: a.funder_kind,
      service_code,
      amount_cents: a.amount_cents,
      kind: "charge",
      adjusts_entry_id: null,
      reason: null,
    }));
    this.#emit({
      event_type: "USAGE_RECORDED",
      aggregate_type: "robot_device",
      aggregate_id: device_id,
      occurred_at,
      summary: `记录用量：${service_code} ${start}~${end}，应计 ${amount} 分`,
      payload: {
        usage_id,
        agreement_id,
        household_id: ag.household_id,
        service_code,
        start,
        end,
        minutes,
        billable_minutes: billable,
        amount_cents: amount,
      },
    });
    for (const entry of entries) this.#proposeEntry(entry, occurred_at, `生成分录 ${entry.entry_id}：${entry.funder_id} 承担 ${entry.amount_cents} 分`);
    return { usage_id, amount_cents: amount, entries };
  }

  /**
   * 记录设备停机。停机时段不计费：尚未拆分的用量在拆分时自然扣除；
   * 已拆分的用量按新增停机时长生成冲正分录（未封账周期内冲正，
   * 原周期已封账的差额转入当前未封账周期并注明原因）。
   */
  recordDowntime({ downtime_id, device_id, start, end, reason, occurred_at }) {
    if (!downtime_id) fail("VALIDATION", "downtime_id 不能为空");
    if (this.#state.downtimeIds.has(downtime_id)) fail("DOWNTIME_EXISTS", `停机记录已存在：${downtime_id}`);
    if (!this.#state.devices.has(device_id)) fail("UNKNOWN_DEVICE", `未知设备：${device_id}`);
    minutesBetween(start, end);
    toMs(occurred_at);
    const before = (this.#state.downtimes.get(device_id) ?? []).map((d) => [d.start, d.end]);
    this.#emit({
      event_type: "DOWNTIME_RECORDED",
      aggregate_type: "robot_device",
      aggregate_id: device_id,
      occurred_at,
      summary: `记录停机：设备 ${device_id} ${start}~${end}（${reason ?? "未注明"}）`,
      payload: { downtime_id, start, end, reason: reason ?? "未注明" },
    });
    const after = (this.#state.downtimes.get(device_id) ?? []).map((d) => [d.start, d.end]);
    const corrections = [];
    for (const usageId of this.#state.deviceUsages.get(device_id) ?? []) {
      const usage = this.#state.usages.get(usageId);
      if (!overlapsInterval(usage.start, usage.end, start, end)) continue;
      const delta = unionCoverageMinutes(after, usage.start, usage.end) - unionCoverageMinutes(before, usage.start, usage.end);
      if (delta <= 0) continue;
      const price = this.#priceAt(usage.service_code, usage.start);
      const reduceCents = Math.round((delta * price) / 60);
      if (reduceCents <= 0) continue;
      const charges = [...this.#state.entries.values()].filter((e) => e.usage_id === usageId && e.kind === "charge");
      const shares = distributeByWeight(reduceCents, charges.map((e) => e.amount_cents));
      charges.forEach((charge, i) => {
        if (shares[i] <= 0) return;
        const entry = this.#postCorrection(charge, -shares[i], `设备停机扣减（${downtime_id}）：${reason ?? "未注明"}`, occurred_at, `cor:${downtime_id}:${usageId}:${charge.funder_id}`);
        corrections.push(entry);
      });
    }
    return corrections;
  }

  // ---------- 台账：确认、入账、争议、封账、回执、退款 ----------

  /** 机构财务确认分录后入账；未确认的分录不计入账务。 */
  confirmEntries(principal, entryIds, occurred_at) {
    requireRole(principal, "finance");
    toMs(occurred_at);
    for (const id of entryIds) {
      const entry = this.#entry(id);
      if (entry.status !== "proposed") fail("ENTRY_NOT_PROPOSED", `分录 ${id} 不在待确认状态`);
    }
    for (const id of entryIds) {
      this.#emit({
        event_type: "ENTRY_POSTED",
        aggregate_type: "ledger_entry",
        aggregate_id: id,
        occurred_at,
        summary: `机构财务确认，分录入账 ${id}`,
        payload: { entry_id: id },
      });
    }
  }

  /** 确认某周期内全部待确认分录，返回入账的分录标识。 */
  confirmPeriod(principal, period, occurred_at) {
    const ids = [...this.#state.entries.values()].filter((e) => e.period === period && e.status === "proposed").map((e) => e.entry_id);
    this.confirmEntries(principal, ids, occurred_at);
    return ids;
  }

  /** 争议只冻结对应分录，不影响同周期其他分录；服务事实（用量记录）不受影响。 */
  raiseDispute(principal, entry_id, reason, occurred_at) {
    const entry = this.#entry(entry_id);
    const allowed =
      principal?.role === "finance" ||
      (principal?.role === "family" && principal.household_id === entry.household_id) ||
      (principal?.role === "funder" && principal.funder_id === entry.funder_id);
    if (!allowed) fail("ACCESS_DENIED", "只能对与本方相关的分录提出争议");
    if (entry.status !== "posted") fail("ENTRY_NOT_POSTED", `分录 ${entry_id} 尚未入账，不能冻结`);
    if (entry.frozen) fail("ALREADY_FROZEN", `分录 ${entry_id} 已处于冻结状态`);
    toMs(occurred_at);
    this.#emit({
      event_type: "ENTRY_DISPUTED",
      aggregate_type: "ledger_entry",
      aggregate_id: entry_id,
      occurred_at,
      summary: `分录 ${entry_id} 因争议冻结：${reason}`,
      payload: { entry_id, reason, raised_by: principal.role },
    });
  }

  /** 解除冻结；可附带更正金额（按净额补差，生成冲正或跨期调整分录）。 */
  resolveDispute(principal, entry_id, { action, corrected_cents, reason }, occurred_at) {
    requireRole(principal, "finance");
    const entry = this.#entry(entry_id);
    if (!entry.frozen) fail("NOT_FROZEN", `分录 ${entry_id} 未处于冻结状态`);
    toMs(occurred_at);
    this.#emit({
      event_type: "ENTRY_DISPUTE_RESOLVED",
      aggregate_type: "ledger_entry",
      aggregate_id: entry_id,
      occurred_at,
      summary: `分录 ${entry_id} 争议解除（${action}）`,
      payload: { entry_id, action, reason: reason ?? null },
    });
    if (action === "correct") {
      const diff = corrected_cents - this.#netAmount(entry_id);
      if (diff !== 0) return [this.#postCorrection(entry, diff, `争议更正：${reason ?? "未注明"}`, occurred_at)];
    }
    return [];
  }

  /**
   * 迟到回执：回执金额与该分录净额有差异时，
   * 原周期未封账则在原周期内冲正；已封账则在当前未封账周期追加差额与原因。
   */
  recordReceipt(principal, entry_id, received_cents, reason, occurred_at) {
    const entry = this.#entry(entry_id);
    const allowed = principal?.role === "finance" || (principal?.role === "funder" && principal.funder_id === entry.funder_id);
    if (!allowed) fail("ACCESS_DENIED", "只能登记与本方相关的回执");
    if (entry.status !== "posted") fail("ENTRY_NOT_POSTED", `分录 ${entry_id} 尚未入账，不能登记回执`);
    if (!Number.isInteger(received_cents) || received_cents < 0) fail("VALIDATION", "received_cents 必须是非负整数");
    toMs(occurred_at);
    const diff = received_cents - this.#netAmount(entry_id);
    if (diff === 0) return null;
    return this.#postCorrection(entry, diff, `迟到回执：${reason}`, occurred_at);
  }

  /** 机构财务发起退款（资金退回付款方）；退款分录立即入账，兑付完成另需确认。 */
  requestRefund(principal, { household_id, funder_id, amount_cents, reason, occurred_at }) {
    requireRole(principal, "finance");
    if (!Number.isInteger(amount_cents) || amount_cents <= 0) fail("VALIDATION", "退款金额必须是正整数（分）");
    toMs(occurred_at);
    const period = periodOf(occurred_at);
    if (!this.#isOpen(period)) fail("NO_OPEN_PERIOD", `周期 ${period} 已封账，无法承接退款`);
    const seq = [...this.#state.entries.values()].filter((e) => e.kind === "refund").length + 1;
    const entry = {
      entry_id: `ref:${household_id}:${funder_id}:${seq}`,
      period,
      household_id,
      agreement_id: null,
      usage_id: null,
      funder_id,
      funder_kind: "refund",
      service_code: null,
      amount_cents: -amount_cents,
      kind: "refund",
      adjusts_entry_id: null,
      reason: reason ?? null,
    };
    this.#emit({
      event_type: "REFUND_REQUESTED",
      aggregate_type: "ledger_entry",
      aggregate_id: entry.entry_id,
      occurred_at,
      summary: `发起退款：${funder_id} 向户 ${household_id} 退回 ${amount_cents} 分`,
      payload: { entry },
    });
    return entry;
  }

  /** 确认退款兑付完成。 */
  completeRefund(principal, entry_id, occurred_at) {
    requireRole(principal, "finance");
    const entry = this.#entry(entry_id);
    if (entry.kind !== "refund" || entry.refund_state !== "requested") fail("REFUND_STATE", `分录 ${entry_id} 不在待兑付状态`);
    toMs(occurred_at);
    this.#emit({
      event_type: "REFUND_COMPLETED",
      aggregate_type: "ledger_entry",
      aggregate_id: entry_id,
      occurred_at,
      summary: `退款兑付完成 ${entry_id}`,
      payload: { entry_id },
    });
  }

  /**
   * 封账：周期内不得有未确认分录；封账后该周期分录不可再变动，
   * 之后的差额只能以调整分录追加到未封账周期。
   */
  sealPeriod(principal, period, occurred_at) {
    requireRole(principal, "finance");
    toMs(occurred_at);
    const status = this.#state.periods.get(period) ?? "open";
    if (status === "sealed") fail("PERIOD_SEALED", `周期 ${period} 已封账`);
    if (status === "open") {
      const pending = [...this.#state.entries.values()].filter((e) => e.period === period && e.status === "proposed");
      if (pending.length > 0) fail("PROPOSED_ENTRIES_REMAIN", `周期 ${period} 尚有 ${pending.length} 条未确认分录，不能封账`);
      this.#emit({
        event_type: "PERIOD_SEALING_STARTED",
        aggregate_type: "billing_period",
        aggregate_id: period,
        occurred_at,
        summary: `开始封账：周期 ${period}`,
        payload: { period },
      });
    }
    this.#settleStatement(period, occurred_at);
    this.#emit({
      event_type: "PERIOD_SEALED",
      aggregate_type: "billing_period",
      aggregate_id: period,
      occurred_at,
      summary: `周期 ${period} 封账完成`,
      payload: { period },
    });
  }

  /** 服务恢复后续跑：完成未完成的封账，继续未兑付的退款。 */
  recover(occurred_at) {
    toMs(occurred_at);
    const resumed = { sealed: [], refunds_completed: [] };
    for (const [period, status] of [...this.#state.periods.entries()]) {
      if (status !== "sealing") continue;
      this.#settleStatement(period, occurred_at);
      this.#emit({
        event_type: "PERIOD_SEALED",
        aggregate_type: "billing_period",
        aggregate_id: period,
        occurred_at,
        summary: `恢复后续跑：周期 ${period} 封账完成`,
        payload: { period },
      });
      resumed.sealed.push(period);
    }
    for (const entry of [...this.#state.entries.values()]) {
      if (entry.kind !== "refund" || entry.refund_state !== "requested") continue;
      this.#emit({
        event_type: "REFUND_COMPLETED",
        aggregate_type: "ledger_entry",
        aggregate_id: entry.entry_id,
        occurred_at,
        summary: `恢复后续跑：退款兑付完成 ${entry.entry_id}`,
        payload: { entry_id: entry.entry_id },
      });
      resumed.refunds_completed.push(entry.entry_id);
    }
    return resumed;
  }

  // ---------- 视图 ----------

  /** 家庭视图：仅本户的用量与分录明细。 */
  familyView(principal, { household_id, period } = {}) {
    requireRole(principal, "family");
    const hid = principal.household_id;
    if (household_id !== undefined && household_id !== hid) fail("ACCESS_DENIED", "家庭只能查看本户明细");
    const usages = [...this.#state.usages.values()]
      .filter((u) => u.household_id === hid)
      .filter((u) => !period || periodOf(u.start) === period)
      .sort((a, b) => toMs(a.start) - toMs(b.start))
      .map((u) => ({
        usage_id: u.usage_id,
        device_id: u.device_id,
        service_code: u.service_code,
        start: u.start,
        end: u.end,
        billable_minutes: u.billable_minutes,
        amount_cents: u.amount_cents,
      }));
    const entries = this.listEntries({ household_id: hid, period }).map((e) => ({
      entry_id: e.entry_id,
      period: e.period,
      funder_id: e.funder_id,
      funder_kind: e.funder_kind,
      service_code: e.service_code,
      amount_cents: e.amount_cents,
      kind: e.kind,
      status: e.status,
      frozen: e.frozen,
      reason: e.reason ?? null,
    }));
    const byFunder = {};
    for (const e of entries.filter((x) => x.status === "posted")) byFunder[e.funder_id] = (byFunder[e.funder_id] ?? 0) + e.amount_cents;
    const due = entries.filter((e) => e.status === "posted" && e.funder_kind === "family_self_pay").reduce((a, e) => a + e.amount_cents, 0);
    return { household_id: hid, period: period ?? null, usages, entries, totals: { by_funder_cents: byFunder, due_from_family_cents: due } };
  }

  /** 资助方视图：仅本方承担的汇总（分周期合计、冻结额、退款额、剩余额度），不含逐条用量明细。 */
  funderView(principal, { period } = {}) {
    requireRole(principal, "funder");
    const fid = principal.funder_id;
    const mine = this.listEntries({ funder_id: fid, period });
    const periods = {};
    const households = {};
    for (const e of mine) {
      if (e.status !== "posted") continue;
      const bucket = (periods[e.period] ??= { borne_cents: 0, frozen_cents: 0, refunded_cents: 0 });
      if (e.kind === "refund") {
        bucket.refunded_cents += -e.amount_cents;
        continue;
      }
      bucket.borne_cents += e.amount_cents;
      if (e.frozen) bucket.frozen_cents += e.amount_cents;
      const h = (households[e.household_id] ??= { borne_cents: 0 });
      h.borne_cents += e.amount_cents;
    }
    const caps = [];
    for (const [hid, decisions] of this.#state.eligibility) {
      const latest = decisions[decisions.length - 1];
      const rule = latest?.funders.find((f) => f.funder_id === fid);
      if (!rule) continue;
      const activity = new Set(mine.filter((e) => e.household_id === hid).map((e) => e.period));
      for (const p of period ? [period] : activity) {
        caps.push({
          household_id: hid,
          period: p,
          cap_cents: rule.cap_cents,
          cap_period: rule.cap_period,
          remaining_cents: rule.cap_cents == null ? null : rule.cap_cents - this.#usedAmount(hid, fid, rule.cap_period, p),
        });
      }
    }
    return { funder_id: fid, periods, households, caps };
  }

  /** 审计视图：逐段用量由谁支付，以及各资助方剩余额度随每笔入账的变化。 */
  auditView(principal, { household_id, period } = {}) {
    requireRole(principal, "audit");
    if (!household_id) fail("VALIDATION", "审计视图需指定 household_id");
    const s = this.#state;
    const usages = [...s.usages.values()]
      .filter((u) => u.household_id === household_id)
      .filter((u) => !period || periodOf(u.start) === period)
      .sort((a, b) => toMs(a.start) - toMs(b.start))
      .map((u) => ({
        usage_id: u.usage_id,
        device_id: u.device_id,
        service_code: u.service_code,
        start: u.start,
        end: u.end,
        billable_minutes: u.billable_minutes,
        amount_cents: u.amount_cents,
        payers: [...s.entries.values()]
          .filter((e) => e.usage_id === u.usage_id)
          .map((e) => ({
            entry_id: e.entry_id,
            funder_id: e.funder_id,
            amount_cents: e.amount_cents,
            kind: e.kind,
            status: e.status,
            frozen: e.frozen,
            period: e.period,
          })),
      }));
    const decisions = s.eligibility.get(household_id) ?? [];
    const latest = decisions[decisions.length - 1];
    const capEvolution = {};
    const funderIds = new Set([...s.entries.values()].filter((e) => e.household_id === household_id).map((e) => e.funder_id));
    for (const fid of funderIds) {
      const rule = latest?.funders.find((f) => f.funder_id === fid);
      const posted = [...s.entries.values()]
        .filter((e) => e.household_id === household_id && e.funder_id === fid && e.status === "posted" && CAP_RELEVANT_KINDS.has(e.kind))
        .sort((a, b) => toMs(a.posted_at) - toMs(b.posted_at) || a.entry_id.localeCompare(b.entry_id));
      const cumByPeriod = new Map();
      let cumTotal = 0;
      const steps = posted.map((e) => {
        let remaining = null;
        if (rule?.cap_cents != null) {
          if (rule.cap_period === "total") {
            cumTotal += e.amount_cents;
            remaining = rule.cap_cents - cumTotal;
          } else {
            const c = (cumByPeriod.get(e.period) ?? 0) + e.amount_cents;
            cumByPeriod.set(e.period, c);
            remaining = rule.cap_cents - c;
          }
        }
        return { entry_id: e.entry_id, period: e.period, amount_cents: e.amount_cents, remaining_after_cents: remaining };
      });
      capEvolution[fid] = { cap_cents: rule?.cap_cents ?? null, cap_period: rule?.cap_period ?? null, steps };
    }
    return { household_id, period: period ?? null, usages, cap_evolution: capEvolution };
  }

  // ---------- 查询 ----------

  listEntries(filter = {}) {
    return [...this.#state.entries.values()].filter(
      (e) =>
        (filter.household_id === undefined || e.household_id === filter.household_id) &&
        (filter.period === undefined || e.period === filter.period) &&
        (filter.funder_id === undefined || e.funder_id === filter.funder_id) &&
        (filter.kind === undefined || e.kind === filter.kind),
    );
  }

  getEntry(entryId) {
    return this.#entry(entryId);
  }

  periodStatus(period) {
    return this.#state.periods.get(period) ?? "open";
  }

  statementOf(period) {
    return this.#state.statements.get(period) ?? null;
  }

  // ---------- 内部 ----------

  #proposeEntry(entry, occurred_at, summary) {
    this.#emit({
      event_type: "ENTRY_PROPOSED",
      aggregate_type: "ledger_entry",
      aggregate_id: entry.entry_id,
      occurred_at,
      summary,
      payload: { entry },
    });
    return entry;
  }

  /** 生成冲正/调整分录：原周期未封账落在原周期（correction），已封账追加到当前未封账周期（adjustment）。 */
  #postCorrection(sourceEntry, diffCents, reason, occurred_at, entryId = null) {
    const targetPeriod = this.#isOpen(sourceEntry.period) ? sourceEntry.period : periodOf(occurred_at);
    if (!this.#isOpen(targetPeriod)) fail("NO_OPEN_PERIOD", `周期 ${targetPeriod} 已封账，无未封账周期可承接调整`);
    const kind = targetPeriod === sourceEntry.period ? "correction" : "adjustment";
    const seq = [...this.#state.entries.values()].filter((e) => e.adjusts_entry_id === sourceEntry.entry_id).length + 1;
    const entry = {
      entry_id: entryId ?? `adj:${sourceEntry.entry_id}:${seq}`,
      period: targetPeriod,
      household_id: sourceEntry.household_id,
      agreement_id: sourceEntry.agreement_id,
      usage_id: sourceEntry.usage_id,
      funder_id: sourceEntry.funder_id,
      funder_kind: sourceEntry.funder_kind,
      service_code: sourceEntry.service_code,
      amount_cents: diffCents,
      kind,
      adjusts_entry_id: sourceEntry.entry_id,
      reason,
    };
    return this.#proposeEntry(entry, occurred_at, `${kind === "correction" ? "同期冲正" : "跨期追加"} ${entry.entry_id}：差额 ${diffCents} 分（${reason}）`);
  }

  #settleStatement(period, occurred_at) {
    if (this.#state.statements.has(period)) return;
    const totals = {};
    let count = 0;
    for (const e of this.#state.entries.values()) {
      if (e.period !== period || e.status !== "posted") continue;
      totals[e.funder_id] = (totals[e.funder_id] ?? 0) + e.amount_cents;
      count += 1;
    }
    this.#emit({
      event_type: "STATEMENT_SETTLED",
      aggregate_type: "funding_statement",
      aggregate_id: `stmt:${period}`,
      occurred_at,
      summary: `周期 ${period} 对账单定稿，共 ${count} 条入账分录`,
      payload: { period, totals, entry_count: count },
    });
  }

  /** 某资助方在额度口径下已占用的分（待确认与已入账均计入，防止超额拆分）。 */
  #usedAmount(householdId, funderId, capPeriod, period) {
    let sum = 0;
    for (const e of this.#state.entries.values()) {
      if (e.household_id !== householdId || e.funder_id !== funderId) continue;
      if (e.status !== "proposed" && e.status !== "posted") continue;
      if (!CAP_RELEVANT_KINDS.has(e.kind)) continue;
      if (capPeriod === "month" && e.period !== period) continue;
      sum += e.amount_cents;
    }
    return sum;
  }

  #netAmount(entryId) {
    let sum = 0;
    for (const e of this.#state.entries.values()) {
      if (e.entry_id === entryId || e.adjusts_entry_id === entryId) sum += e.amount_cents;
    }
    return sum;
  }

  #eligibilityAt(householdId, atIso) {
    const list = this.#state.eligibility.get(householdId) ?? [];
    const at = toMs(atIso);
    const effective = list.filter((d) => toMs(d.effective_from) <= at);
    const chosen = effective[effective.length - 1];
    return chosen ? chosen.funders : null;
  }

  #priceAt(serviceCode, atIso) {
    const at = toMs(atIso);
    let best = null;
    for (const versions of this.#state.packages.values()) {
      for (const v of versions) {
        if (toMs(v.effective_from) > at) continue;
        const item = v.items[serviceCode];
        if (!item) continue;
        if (!best || toMs(v.effective_from) > toMs(best.effective_from)) best = { effective_from: v.effective_from, price: item.unit_price_cents };
      }
    }
    return best ? best.price : null;
  }

  #isOpen(period) {
    const status = this.#state.periods.get(period);
    return status === undefined || status === "open";
  }

  #agreement(agreementId) {
    const ag = this.#state.agreements.get(agreementId);
    if (!ag) fail("UNKNOWN_AGREEMENT", `未知租赁协议：${agreementId}`);
    return ag;
  }

  #entry(entryId) {
    const entry = this.#state.entries.get(entryId);
    if (!entry) fail("UNKNOWN_ENTRY", `未知分录：${entryId}`);
    return entry;
  }

  /** 设备占用检查：同一设备在 [start, end) 内不得与其他协议的占用段重叠（并发占用必须拒绝）。 */
  #assertDeviceFree(deviceId, start, end, exceptAgreementId) {
    for (const [agreementId, ag] of this.#state.agreements) {
      if (agreementId === exceptAgreementId) continue;
      for (const seg of ag.chain) {
        if (seg.device_id !== deviceId) continue;
        if (overlapsInterval(seg.from, seg.to, start, end)) {
          fail("DEVICE_OCCUPIED", `设备 ${deviceId} 在 ${seg.from}~${seg.to} 已被协议 ${agreementId} 占用，拒绝并发占用`);
        }
      }
    }
  }
}
