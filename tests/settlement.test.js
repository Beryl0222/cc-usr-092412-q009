import assert from "node:assert/strict";
import test from "node:test";

import { validateEvent } from "../src/validator.js";
import { boot, setupStandard, entriesOf, centsOf, FIN, familyOf } from "./helpers.js";

const U = (id, service, day, from, to) => ({
  usage_id: id,
  agreement_id: "A1",
  device_id: "D1",
  service_code: service,
  start: `2026-09-${day}T${from}:00+08:00`,
  end: `2026-09-${day}T${to}:00+08:00`,
  occurred_at: `2026-09-${day}T${to}:05+08:00`,
});

test("按优先级与额度拆分，同一小时不向两方重复申报", () => {
  const { svc } = boot();
  setupStandard(svc);

  const u1 = svc.recordUsage(U("U1", "COMPANION", "10", "10:00", "11:00"));
  assert.equal(u1.amount_cents, 12000);
  const e1 = entriesOf(svc, "U1");
  // 政府补贴月上限 10000 分用尽，长期护理账户不适用陪伴照护，余下 2000 分由家庭兜底
  assert.equal(centsOf(e1, "gov"), 10000);
  assert.equal(centsOf(e1, "ltc"), 0);
  assert.equal(centsOf(e1, "fam-H1"), 2000);

  const u2 = svc.recordUsage(U("U2", "REHAB", "11", "10:00", "11:00"));
  assert.equal(u2.amount_cents, 20000);
  const e2 = entriesOf(svc, "U2");
  // 政府补贴当月额度已被 U1 占满，康复训练由长期护理账户承担 5000，余下家庭自付
  assert.equal(centsOf(e2, "gov"), 0);
  assert.equal(centsOf(e2, "ltc"), 5000);
  assert.equal(centsOf(e2, "fam-H1"), 15000);

  // 每段用量的分录合计等于应计费用，且同一资助方在同一段用量上至多一条分录
  for (const [usageId, amount] of [["U1", 12000], ["U2", 20000]]) {
    const entries = entriesOf(svc, usageId);
    assert.equal(entries.reduce((a, e) => a + e.amount_cents, 0), amount);
    assert.equal(new Set(entries.map((e) => e.funder_id)).size, entries.length);
  }
  // 任一资助方不超过其上限
  const govTotal = centsOf(svc.listEntries({ funder_id: "gov" }), "gov");
  const ltcTotal = centsOf(svc.listEntries({ funder_id: "ltc" }), "ltc");
  assert.ok(govTotal <= 10000, `政府补贴超出上限：${govTotal}`);
  assert.ok(ltcTotal <= 5000, `长期护理账户超出上限：${ltcTotal}`);
});

test("每段费用依据服务发生时的资格与价格拆分", () => {
  const { svc } = boot();
  setupStandard(svc);
  // 户 H2：9 月上半月政府补贴覆盖陪伴照护，9 月 15 日起不再覆盖
  svc.assessEligibility({
    household_id: "H2",
    effective_from: "2026-09-01T00:00:00+08:00",
    occurred_at: "2026-08-31T12:00:00+08:00",
    funders: [
      { funder_id: "gov", kind: "government_subsidy", priority: 1, cap_cents: 10000, cap_period: "month", services: ["COMPANION"] },
      { funder_id: "fam-H2", kind: "family_self_pay", priority: 2, cap_cents: null, cap_period: null, services: "*" },
    ],
  });
  svc.assessEligibility({
    household_id: "H2",
    effective_from: "2026-09-15T00:00:00+08:00",
    occurred_at: "2026-09-14T09:00:00+08:00",
    funders: [
      { funder_id: "gov", kind: "government_subsidy", priority: 1, cap_cents: 10000, cap_period: "month", services: ["REHAB"] },
      { funder_id: "fam-H2", kind: "family_self_pay", priority: 2, cap_cents: null, cap_period: null, services: "*" },
    ],
  });
  // 9 月 15 日起陪伴照护涨价为 150 元/小时
  svc.publishPackage({
    package_id: "pkg-basic",
    effective_from: "2026-09-15T00:00:00+08:00",
    occurred_at: "2026-09-14T09:00:00+08:00",
    items: { COMPANION: { unit_price_cents: 15000, unit: "hour" }, REHAB: { unit_price_cents: 20000, unit: "hour" } },
  });
  svc.scheduleRental({
    agreement_id: "A2",
    household_id: "H2",
    device_id: "D2",
    start: "2026-09-01T00:00:00+08:00",
    end: "2026-10-01T00:00:00+08:00",
    occurred_at: "2026-08-31T12:00:00+08:00",
  });

  const before = svc.recordUsage({
    usage_id: "UB1", agreement_id: "A2", device_id: "D2", service_code: "COMPANION",
    start: "2026-09-10T10:00:00+08:00", end: "2026-09-10T11:00:00+08:00", occurred_at: "2026-09-10T11:05:00+08:00",
  });
  assert.equal(before.amount_cents, 12000); // 旧价格
  assert.equal(centsOf(entriesOf(svc, "UB1"), "gov"), 10000); // 旧资格：政府补贴覆盖

  const after = svc.recordUsage({
    usage_id: "UB2", agreement_id: "A2", device_id: "D2", service_code: "COMPANION",
    start: "2026-09-20T10:00:00+08:00", end: "2026-09-20T11:00:00+08:00", occurred_at: "2026-09-20T11:05:00+08:00",
  });
  assert.equal(after.amount_cents, 15000); // 新价格
  const eAfter = entriesOf(svc, "UB2");
  assert.equal(centsOf(eAfter, "gov"), 0); // 新资格：政府补贴不再覆盖陪伴照护
  assert.equal(centsOf(eAfter, "fam-H2"), 15000);
});

test("重复计量与重复拆分被拒绝", () => {
  const { svc } = boot();
  setupStandard(svc);
  svc.recordUsage(U("U1", "COMPANION", "10", "10:00", "11:00"));
  assert.throws(() => svc.recordUsage(U("U1", "COMPANION", "10", "10:00", "11:00")), /已存在/);
  assert.throws(
    () => svc.recordUsage(U("U2", "COMPANION", "10", "10:30", "11:30")),
    (err) => err.code === "METERING_OVERLAP",
  );
  // 拆分只发生一次：U1 的分录不因任何重试而翻倍
  assert.equal(entriesOf(svc, "U1").reduce((a, e) => a + e.amount_cents, 0), 12000);
});

test("每段费用先拆分，再由机构财务确认后入账", () => {
  const { svc } = boot();
  setupStandard(svc);
  svc.recordUsage(U("U1", "COMPANION", "10", "10:00", "11:00"));
  const ids = entriesOf(svc, "U1").map((e) => e.entry_id);
  assert.ok(ids.every((id) => svc.getEntry(id).status === "proposed"));

  assert.throws(() => svc.confirmEntries(familyOf("H1"), ids, "2026-09-12T09:00:00+08:00"), /ACCESS_DENIED|需要 finance 角色/);
  svc.confirmEntries(FIN, ids, "2026-09-12T09:00:00+08:00");
  assert.ok(ids.every((id) => svc.getEntry(id).status === "posted"));
  assert.throws(() => svc.confirmEntries(FIN, ids, "2026-09-12T10:00:00+08:00"), (err) => err.code === "ENTRY_NOT_PROPOSED");
});

test("全流程产生的事件均通过信封校验", () => {
  const { store, svc } = boot();
  setupStandard(svc);
  svc.recordUsage(U("U1", "COMPANION", "10", "10:00", "11:00"));
  svc.recordDowntime({
    downtime_id: "DT1", device_id: "D1",
    start: "2026-09-11T09:00:00+08:00", end: "2026-09-11T10:00:00+08:00",
    reason: "例行保养", occurred_at: "2026-09-11T10:30:00+08:00",
  });
  svc.confirmPeriod(FIN, "2026-09", "2026-09-30T18:00:00+08:00");
  svc.sealPeriod(FIN, "2026-09", "2026-10-01T09:00:00+08:00");
  for (const event of store.all()) assert.deepEqual(validateEvent(event), [], `事件 ${event.event_id} 未通过校验`);
});
