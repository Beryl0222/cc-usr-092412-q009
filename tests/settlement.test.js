import assert from "node:assert/strict";
import test from "node:test";

import { createEngine, replayJournal, UNCOVERED_FUNDER } from "../src/engine.js";

const FINANCE = { role: "finance", name: "机构财务小赵" };

/**
 * 搭建标准场景：三个资助方（政府补贴 > 长期护理账户 > 家庭自付）、
 * 一个服务包、一位老人（王奶奶）的资格与租约。时钟可随测试推进。
 */
function buildWorld(initialClock = "2026-09-30T23:00:00+08:00") {
  let clock = initialClock;
  const engine = createEngine({ now: () => clock });
  engine.registerFunder({ funder_id: "gov", name: "政府补贴", kind: "subsidy", priority: 1 });
  engine.registerFunder({ funder_id: "ltc", name: "长期护理账户", kind: "ltc", priority: 2 });
  engine.registerFunder({ funder_id: "family", name: "家庭自付", kind: "family_self_pay", priority: 3 });
  engine.registerServicePackage({
    package_id: "pkg-basic",
    effective_from: "2026-09-01T00:00:00+08:00",
    items: { companion: 5000, rehab: 8000 },
    coverage: { gov: ["companion", "rehab"], ltc: ["companion"], family: ["companion", "rehab"] },
  });
  engine.assessEligibility({
    recipient_id: "rcpt-wang",
    funder_id: "gov",
    effective_from: "2026-09-01T00:00:00+08:00",
    monthly_cap_cents: 100000,
    covered_services: ["companion", "rehab"],
    decided_by: "评估员小李",
  });
  engine.assessEligibility({
    recipient_id: "rcpt-wang",
    funder_id: "ltc",
    effective_from: "2026-09-01T00:00:00+08:00",
    monthly_cap_cents: 60000,
    covered_services: ["companion"],
    decided_by: "评估员小李",
  });
  engine.assessEligibility({
    recipient_id: "rcpt-wang",
    funder_id: "family",
    effective_from: "2026-09-01T00:00:00+08:00",
    monthly_cap_cents: 50000,
    covered_services: ["companion", "rehab"],
    decided_by: "评估员小李",
  });
  engine.openRental({
    agreement_id: "agr-wang",
    household_id: "hh-wang",
    recipient_id: "rcpt-wang",
    device_id: "robot-01",
    from: "2026-09-01T08:00:00+08:00",
  });
  return { engine, setClock: (iso) => (clock = iso) };
}

function usage(engine, usage_id, start, end, service_code = "companion", device_id = "robot-01") {
  engine.recordUsage({ usage_id, agreement_id: "agr-wang", device_id, service_code, package_id: "pkg-basic", start, end });
}

function entriesFor(engine, usage_id) {
  return engine.listEntries({ usage_id });
}

test("资格决定与服务包分别版本化，费用按服务发生时的规则拆分", () => {
  const { engine } = buildWorld();
  // 9 月 15 日起政府补贴复核：不再覆盖康复训练，额度上调
  engine.assessEligibility({
    recipient_id: "rcpt-wang",
    funder_id: "gov",
    effective_from: "2026-09-15T00:00:00+08:00",
    monthly_cap_cents: 120000,
    covered_services: ["companion"],
    decided_by: "复核员小周",
  });
  // 9 月 20 日起服务包调价：陪伴照护 50 → 60 元/小时
  engine.registerServicePackage({
    package_id: "pkg-basic",
    effective_from: "2026-09-20T00:00:00+08:00",
    items: { companion: 6000, rehab: 8000 },
    coverage: { gov: ["companion", "rehab"], ltc: ["companion"], family: ["companion", "rehab"] },
  });

  usage(engine, "u-rehab-before", "2026-09-10T09:00:00+08:00", "2026-09-10T10:00:00+08:00", "rehab");
  usage(engine, "u-rehab-after", "2026-09-16T09:00:00+08:00", "2026-09-16T10:00:00+08:00", "rehab");
  usage(engine, "u-comp-before", "2026-09-19T09:00:00+08:00", "2026-09-19T10:00:00+08:00");
  usage(engine, "u-comp-after", "2026-09-21T09:00:00+08:00", "2026-09-21T10:00:00+08:00");

  // 复核前的康复训练仍由政府补贴承担
  assert.deepEqual(
    entriesFor(engine, "u-rehab-before").map((e) => [e.funder_id, e.amount_cents]),
    [["gov", 8000]],
  );
  // 复核后政府不再覆盖康复训练，落到家庭自付
  assert.deepEqual(
    entriesFor(engine, "u-rehab-after").map((e) => [e.funder_id, e.amount_cents]),
    [["family", 8000]],
  );
  // 调价前后分别按当时单价计费
  assert.equal(entriesFor(engine, "u-comp-before")[0].amount_cents, 5000);
  assert.equal(entriesFor(engine, "u-comp-after")[0].amount_cents, 6000);

  // 历史版本完整保留，不得原地改写
  assert.equal(engine.getEligibilityHistory("rcpt-wang", "gov").length, 2);
  assert.equal(engine.getPackageHistory("pkg-basic").length, 2);
  assert.equal(engine.getEligibilityHistory("rcpt-wang", "gov")[0].monthly_cap_cents, 100000);
});

test("资助方按优先级承担费用，任何一方不得突破月度额度", () => {
  const { engine } = buildWorld();
  // 48 小时陪伴照护，共 2400 元，超过三方额度总和
  usage(engine, "u-big", "2026-09-10T00:00:00+08:00", "2026-09-12T00:00:00+08:00");

  const entries = entriesFor(engine, "u-big");
  const byFunder = Object.fromEntries(entries.map((e) => [e.funder_id, e.amount_cents]));
  assert.equal(byFunder.gov, 100000); // 政府补贴到顶
  assert.equal(byFunder.ltc, 60000); // 长护账户到顶
  assert.equal(byFunder.family, 50000); // 家庭自付到顶
  assert.equal(byFunder[UNCOVERED_FUNDER], 30000); // 剩余进入未覆盖桶
  assert.equal(entries.reduce((s, e) => s + e.amount_cents, 0), 240000);

  for (const cap of engine.remainingCaps("rcpt-wang", "2026-09")) {
    assert.equal(cap.remaining_cents, 0, `${cap.funder_id} 额度应恰好用完`);
    assert.ok(cap.used_cents <= cap.cap_cents, `${cap.funder_id} 不得突破上限`);
  }
});

test("分录须经机构财务确认后方可入账，封账后不得重复封账", () => {
  const { engine } = buildWorld();
  usage(engine, "u-1", "2026-09-05T08:00:00+08:00", "2026-09-05T10:00:00+08:00");
  assert.equal(entriesFor(engine, "u-1")[0].status, "draft");

  // 存在未确认分录时不能封账
  assert.throws(
    () => engine.closePeriod({ principal: FINANCE, recipient_id: "rcpt-wang", period: "2026-09" }),
    /未确认分录/,
  );
  // 非财务角色不能确认
  assert.throws(
    () =>
      engine.confirmCharges({ principal: { role: "family", household_id: "hh-wang" }, recipient_id: "rcpt-wang", period: "2026-09" }),
    /仅机构财务/,
  );

  engine.confirmCharges({ principal: FINANCE, recipient_id: "rcpt-wang", period: "2026-09", confirmed_by: "财务小赵" });
  assert.equal(entriesFor(engine, "u-1")[0].status, "confirmed");

  engine.closePeriod({ principal: FINANCE, recipient_id: "rcpt-wang", period: "2026-09", closed_by: "财务小赵" });
  assert.equal(entriesFor(engine, "u-1")[0].status, "posted");
  assert.equal(engine.getPeriodStatus("rcpt-wang", "2026-09"), "closed");

  assert.throws(
    () => engine.closePeriod({ principal: FINANCE, recipient_id: "rcpt-wang", period: "2026-09" }),
    /已封账/,
  );
});

test("争议只冻结对应分录，服务事实不回滚，解除后在未封账周期补登", () => {
  const { engine, setClock } = buildWorld();
  usage(engine, "u-disputed", "2026-09-05T08:00:00+08:00", "2026-09-05T10:00:00+08:00");
  usage(engine, "u-normal", "2026-09-06T08:00:00+08:00", "2026-09-06T10:00:00+08:00");
  const disputed = entriesFor(engine, "u-disputed")[0];
  const normal = entriesFor(engine, "u-normal")[0];

  engine.raiseDispute({ dispute_id: "disp-1", entry_ids: [disputed.entry_id], reason: "家属质疑该时段未上门服务" });
  assert.equal(engine.getEntry(disputed.entry_id).status, "frozen");

  // 其余分录照常确认、封账，不受争议影响
  engine.confirmCharges({ principal: FINANCE, recipient_id: "rcpt-wang", period: "2026-09" });
  engine.closePeriod({ principal: FINANCE, recipient_id: "rcpt-wang", period: "2026-09" });
  assert.equal(engine.getEntry(normal.entry_id).status, "posted");
  assert.equal(engine.getEntry(disputed.entry_id).status, "frozen");

  // 老人已获得的服务事实（计量记录）不回滚
  assert.equal(engine.getUsage("u-disputed").status, "active");
  assert.equal(engine.getUsage("u-disputed").pieces.length, 1);

  // 争议解除：原周期已封账，差额补登到当前未封账周期
  setClock("2026-10-02T09:00:00+08:00");
  engine.resolveDispute({ dispute_id: "disp-1", mode: "release", reason: "查监控确认服务属实" });
  assert.equal(engine.getEntry(disputed.entry_id).status, "reversed");
  const reinstated = engine.listEntries({ booking_period: "2026-10" })[0];
  assert.equal(reinstated.kind, "adjustment");
  assert.equal(reinstated.amount_cents, 10000);
  assert.equal(reinstated.service_period, "2026-09");
  assert.match(reinstated.reason, /争议解除补登/);

  engine.confirmCharges({ principal: FINANCE, recipient_id: "rcpt-wang", period: "2026-10" });
  engine.closePeriod({ principal: FINANCE, recipient_id: "rcpt-wang", period: "2026-10" });
  assert.equal(engine.getEntry(reinstated.entry_id).status, "posted");
});

test("争议成立时冲销已入账分录，并在当前周期生成等额负向差额", () => {
  const { engine, setClock } = buildWorld();
  usage(engine, "u-1", "2026-09-05T08:00:00+08:00", "2026-09-05T10:00:00+08:00");
  engine.confirmCharges({ principal: FINANCE, recipient_id: "rcpt-wang", period: "2026-09" });
  engine.closePeriod({ principal: FINANCE, recipient_id: "rcpt-wang", period: "2026-09" });
  const posted = entriesFor(engine, "u-1")[0];
  assert.equal(posted.status, "posted");

  setClock("2026-10-02T09:00:00+08:00");
  engine.raiseDispute({ dispute_id: "disp-2", entry_ids: [posted.entry_id], reason: "查无当日服务记录" });
  engine.resolveDispute({ dispute_id: "disp-2", mode: "uphold", reason: "确认为重复申报" });

  // 已入账分录保留在已封账的 9 月作为历史，10 月生成等额负向差额冲销
  assert.equal(engine.getEntry(posted.entry_id).status, "posted");
  const clawback = engine.listEntries({ booking_period: "2026-10" })[0];
  assert.equal(clawback.amount_cents, -10000);
  assert.equal(clawback.service_period, "2026-09");
  assert.match(clawback.reason, /争议成立冲销/);

  // 原分录与负向差额相抵，政府补贴额度相应释放
  const gov = engine.remainingCaps("rcpt-wang", "2026-09").find((c) => c.funder_id === "gov");
  assert.equal(gov.used_cents, 0);
});

test("换机保留租赁连续性，重叠计量与同一设备并发占用必须拒绝", () => {
  const { engine } = buildWorld();
  usage(engine, "u-before-swap", "2026-09-05T08:00:00+08:00", "2026-09-05T09:00:00+08:00");

  engine.replaceDevice({
    agreement_id: "agr-wang",
    new_device_id: "robot-02",
    replaced_at: "2026-09-10T10:00:00+08:00",
    reason: "主板故障临时替换",
  });

  // 租赁连续性：同一租约，设备分配链首尾相接
  const timeline = engine.getRentalTimeline("agr-wang");
  assert.equal(timeline.agreement_id, "agr-wang");
  assert.deepEqual(
    timeline.assignments.map((a) => [a.device_id, a.from, a.to]),
    [
      ["robot-01", "2026-09-01T08:00:00+08:00", "2026-09-10T10:00:00+08:00"],
      ["robot-02", "2026-09-10T10:00:00+08:00", null],
    ],
  );

  // 换机后旧设备不再接受计量
  assert.throws(
    () => usage(engine, "u-old-device", "2026-09-10T11:00:00+08:00", "2026-09-10T12:00:00+08:00", "companion", "robot-01"),
    /未分配给租约/,
  );
  // 新设备正常计量
  usage(engine, "u-new-device", "2026-09-10T10:00:00+08:00", "2026-09-10T12:00:00+08:00", "companion", "robot-02");
  // 同一设备重叠计量被拒绝
  assert.throws(
    () => usage(engine, "u-overlap", "2026-09-10T11:00:00+08:00", "2026-09-10T13:00:00+08:00", "companion", "robot-02"),
    /重叠/,
  );

  // 另一户租约若排到同一台设备，同一时段并发占用被拒绝
  engine.openRental({
    agreement_id: "agr-li",
    household_id: "hh-li",
    recipient_id: "rcpt-li",
    device_id: "robot-02",
    from: "2026-09-10T08:00:00+08:00",
  });
  assert.throws(
    () =>
      engine.recordUsage({
        usage_id: "u-concurrent",
        agreement_id: "agr-li",
        device_id: "robot-02",
        service_code: "companion",
        package_id: "pkg-basic",
        start: "2026-09-10T11:00:00+08:00",
        end: "2026-09-10T12:00:00+08:00",
      }),
    /并发占用/,
  );
});

test("停机时段不计费，迟到登记的停机冲减已入账费用并产生退款", () => {
  const { engine, setClock } = buildWorld();
  // 先登记停机，再计量：停机一小时不计费
  engine.recordDowntime({ device_id: "robot-01", from: "2026-09-05T09:00:00+08:00", to: "2026-09-05T10:00:00+08:00", reason: "系统升级" });
  usage(engine, "u-partial", "2026-09-05T08:00:00+08:00", "2026-09-05T12:00:00+08:00");
  const partialTotal = entriesFor(engine, "u-partial").reduce((s, e) => s + e.amount_cents, 0);
  assert.equal(partialTotal, 15000); // 4 小时扣掉停机 1 小时，按 3 小时计

  // 9 月 6 日正常使用并入账封账
  usage(engine, "u-full", "2026-09-06T08:00:00+08:00", "2026-09-06T12:00:00+08:00");
  engine.confirmCharges({ principal: FINANCE, recipient_id: "rcpt-wang", period: "2026-09" });
  engine.closePeriod({ principal: FINANCE, recipient_id: "rcpt-wang", period: "2026-09" });

  // 事后补登当天两小时停机：在 10 月账期生成负向差额
  setClock("2026-10-02T09:00:00+08:00");
  engine.recordDowntime({ device_id: "robot-01", from: "2026-09-06T10:00:00+08:00", to: "2026-09-06T12:00:00+08:00", reason: "主机过热停机" });
  const clawback = engine.listEntries({ booking_period: "2026-10" })[0];
  assert.equal(clawback.kind, "adjustment");
  assert.equal(clawback.amount_cents, -10000);
  assert.equal(clawback.funder_id, "gov");
  assert.equal(clawback.service_period, "2026-09");
  assert.match(clawback.reason, /停机冲减/);

  // 10 月封账后政府补贴净额为负，生成退款义务并支付
  engine.confirmCharges({ principal: FINANCE, recipient_id: "rcpt-wang", period: "2026-10" });
  engine.closePeriod({ principal: FINANCE, recipient_id: "rcpt-wang", period: "2026-10" });
  const refunds = engine.listRefunds();
  assert.equal(refunds.length, 1);
  assert.deepEqual(
    refunds.map((r) => [r.funder_id, r.amount_cents, r.status]),
    [["gov", 10000, "pending"]],
  );
  engine.processRefunds();
  assert.equal(engine.listRefunds()[0].status, "paid");
});

test("迟到回执只调整未封账周期，已封账周期追加差额与原因", () => {
  const { engine, setClock } = buildWorld();
  usage(engine, "u-ontime", "2026-09-20T09:00:00+08:00", "2026-09-20T10:00:00+08:00");
  engine.confirmCharges({ principal: FINANCE, recipient_id: "rcpt-wang", period: "2026-09" });
  engine.closePeriod({ principal: FINANCE, recipient_id: "rcpt-wang", period: "2026-09" });

  // 10 月才收到 9 月 25 日的回执：差额追加到 10 月，额度仍按 9 月核算
  setClock("2026-10-03T09:00:00+08:00");
  usage(engine, "u-late", "2026-09-25T14:00:00+08:00", "2026-09-25T16:00:00+08:00");
  const late = entriesFor(engine, "u-late");
  assert.equal(late.length, 1);
  assert.equal(late[0].kind, "adjustment");
  assert.equal(late[0].booking_period, "2026-10");
  assert.equal(late[0].service_period, "2026-09");
  assert.match(late[0].reason, /迟到回执补登/);

  const gov = engine.remainingCaps("rcpt-wang", "2026-09").find((c) => c.funder_id === "gov");
  assert.equal(gov.used_cents, 5000 + 10000); // 9 月额度被迟到回执占用

  // 跨月回执：9 月部分追加差额，10 月部分正常拆分
  usage(engine, "u-cross-month", "2026-09-30T22:00:00+08:00", "2026-10-01T02:00:00+08:00");
  const cross = entriesFor(engine, "u-cross-month");
  const sep = cross.find((e) => e.service_period === "2026-09");
  const oct = cross.find((e) => e.service_period === "2026-10");
  assert.equal(sep.kind, "adjustment");
  assert.equal(sep.booking_period, "2026-10");
  assert.equal(oct.kind, "charge");
  assert.equal(oct.booking_period, "2026-10");

  // 已封账的 9 月账目不被改写
  assert.equal(engine.getPeriodStatus("rcpt-wang", "2026-09"), "closed");
});

test("服务恢复后状态一致，并继续未完成的封账和退款", () => {
  const { engine, setClock } = buildWorld();
  usage(engine, "u-1", "2026-09-06T08:00:00+08:00", "2026-09-06T12:00:00+08:00");
  engine.confirmCharges({ principal: FINANCE, recipient_id: "rcpt-wang", period: "2026-09" });
  engine.closePeriod({ principal: FINANCE, recipient_id: "rcpt-wang", period: "2026-09" });
  setClock("2026-10-02T09:00:00+08:00");
  engine.recordDowntime({ device_id: "robot-01", from: "2026-09-06T10:00:00+08:00", to: "2026-09-06T12:00:00+08:00", reason: "主机过热停机" });
  engine.confirmCharges({ principal: FINANCE, recipient_id: "rcpt-wang", period: "2026-10" });
  engine.closePeriod({ principal: FINANCE, recipient_id: "rcpt-wang", period: "2026-10" });
  // 退款尚未支付时服务中断
  assert.equal(engine.listRefunds()[0].status, "pending");

  // 从事件日志恢复：状态完全一致，续作把待支付退款付清
  const recovered = replayJournal(engine.getJournal(), { now: () => "2026-10-05T09:00:00+08:00" });
  assert.deepEqual(recovered.remainingCaps("rcpt-wang", "2026-09"), engine.remainingCaps("rcpt-wang", "2026-09"));
  assert.equal(recovered.getPeriodStatus("rcpt-wang", "2026-10"), "closed");
  assert.equal(recovered.listEntries().length, engine.listEntries().length);
  recovered.resumePending();
  assert.equal(recovered.listRefunds()[0].status, "paid");
});

test("封账进行到一半服务中断，恢复后续作完成封账", () => {
  const { engine } = buildWorld();
  usage(engine, "u-1", "2026-09-05T08:00:00+08:00", "2026-09-05T10:00:00+08:00");
  engine.confirmCharges({ principal: FINANCE, recipient_id: "rcpt-wang", period: "2026-09" });
  engine.beginPeriodClose({ recipient_id: "rcpt-wang", period: "2026-09" });
  // 服务在封账中途停止

  const recovered = replayJournal(engine.getJournal(), { now: () => "2026-09-30T23:30:00+08:00" });
  assert.equal(recovered.getPeriodStatus("rcpt-wang", "2026-09"), "closing");
  recovered.resumePending();
  assert.equal(recovered.getPeriodStatus("rcpt-wang", "2026-09"), "closed");
  assert.equal(recovered.listEntries({ usage_id: "u-1" })[0].status, "posted");

  // 续作幂等：再次调用不产生新事件
  const journalSize = recovered.getJournal().length;
  recovered.resumePending();
  assert.equal(recovered.getJournal().length, journalSize);
});

test("家庭只能看本户明细，资助方只能看自己承担的汇总，审计可证明每小时的支付方", () => {
  const { engine } = buildWorld();
  usage(engine, "u-1", "2026-09-05T08:00:00+08:00", "2026-09-05T10:00:00+08:00");
  engine.confirmCharges({ principal: FINANCE, recipient_id: "rcpt-wang", period: "2026-09" });
  engine.closePeriod({ principal: FINANCE, recipient_id: "rcpt-wang", period: "2026-09" });

  // 家庭视图：本户明细齐全
  const familyView = engine.familyStatement({ role: "family", household_id: "hh-wang" }, "hh-wang", "2026-09");
  assert.equal(familyView.lines.length, 1);
  assert.equal(familyView.lines[0].service_code, "companion");
  assert.equal(familyView.totals_by_funder.gov, 10000);
  assert.equal(familyView.family_payable_cents, 0);
  // 跨户访问被拒绝
  assert.throws(
    () => engine.familyStatement({ role: "family", household_id: "hh-wang" }, "hh-li", "2026-09"),
    /本户明细/,
  );

  // 资助方视图：只有自身汇总，没有服务明细，没有其他资助方
  const govView = engine.funderSummary({ role: "funder", funder_id: "gov" }, "gov", "2026-09");
  assert.equal(govView.total_cents, 10000);
  assert.deepEqual(govView.by_service_period, [{ service_period: "2026-09", total_cents: 10000 }]);
  assert.ok(!("lines" in govView));
  assert.ok(!JSON.stringify(govView).includes("companion"));
  assert.throws(() => engine.funderSummary({ role: "funder", funder_id: "gov" }, "ltc", "2026-09"), /自身承担/);

  // 审计视图：每一小时由谁支付、剩余额度如何变化
  const audit = engine.auditTrail({ role: "audit" }, "rcpt-wang", "2026-09");
  assert.equal(audit.hourly.length, 1);
  assert.deepEqual(
    audit.hourly[0].payers.map((p) => [p.funder_id, p.amount_cents]),
    [["gov", 10000]],
  );
  const govLine = audit.entries.find((e) => e.funder_id === "gov");
  assert.equal(govLine.cap_cents, 100000);
  assert.equal(govLine.used_before_cents, 0);
  assert.equal(govLine.used_after_cents, 10000);
  assert.equal(govLine.remaining_after_cents, 90000);
  assert.deepEqual(audit.remaining_caps.find((c) => c.funder_id === "gov").remaining_cents, 90000);
  // 非审计角色不得访问
  assert.throws(() => engine.auditTrail({ role: "family", household_id: "hh-wang" }, "rcpt-wang", "2026-09"), /仅审计角色/);
});

test("同一小时的费用只拆分一次，不会向两方重复申报", () => {
  const { engine } = buildWorld();
  usage(engine, "u-1", "2026-09-05T08:00:00+08:00", "2026-09-05T10:00:00+08:00");

  // 分录总额恰好等于这一段计量的总价，每个资助方各承担不相交的一部分
  const entries = entriesFor(engine, "u-1");
  const gross = engine.getUsage("u-1").pieces[0].gross_cents;
  assert.equal(entries.reduce((s, e) => s + e.amount_cents, 0), gross);
  assert.equal(new Set(entries.map((e) => e.funder_id)).size, entries.length);

  // 审计视图中该时段各支付方金额之和等于总价，不存在重复申报
  const audit = engine.auditTrail({ role: "audit" }, "rcpt-wang", "2026-09");
  for (const hour of audit.hourly) {
    assert.equal(hour.payers.reduce((s, p) => s + p.amount_cents, 0), hour.gross_cents);
  }

  // 同一设备同一时段的第二次计量直接被拒绝
  assert.throws(
    () => usage(engine, "u-dup", "2026-09-05T09:00:00+08:00", "2026-09-05T11:00:00+08:00"),
    /重叠/,
  );
});
