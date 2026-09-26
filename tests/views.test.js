import assert from "node:assert/strict";
import test from "node:test";

import { boot, setupStandard, FIN, AUDIT, familyOf, funderOf } from "./helpers.js";

/** 两户环境：H1（gov/ltc/家庭兜底，设备 D1），H2（ltc/家庭兜底，设备 D2）。 */
function setupTwoHouseholds(svc) {
  setupStandard(svc);
  svc.assessEligibility({
    household_id: "H2",
    effective_from: "2026-09-01T00:00:00+08:00",
    occurred_at: "2026-08-31T12:00:00+08:00",
    funders: [
      { funder_id: "ltc", kind: "ltc_account", priority: 1, cap_cents: 8000, cap_period: "month", services: "*" },
      { funder_id: "fam-H2", kind: "family_self_pay", priority: 2, cap_cents: null, cap_period: null, services: "*" },
    ],
  });
  svc.scheduleRental({
    agreement_id: "A2",
    household_id: "H2",
    device_id: "D2",
    start: "2026-09-01T00:00:00+08:00",
    end: "2026-10-01T00:00:00+08:00",
    occurred_at: "2026-08-31T12:00:00+08:00",
  });
  svc.recordUsage({ usage_id: "U1", agreement_id: "A1", device_id: "D1", service_code: "COMPANION", start: "2026-09-10T10:00:00+08:00", end: "2026-09-10T11:00:00+08:00", occurred_at: "2026-09-10T11:05:00+08:00" });
  svc.recordUsage({ usage_id: "U2", agreement_id: "A1", device_id: "D1", service_code: "REHAB", start: "2026-09-11T10:00:00+08:00", end: "2026-09-11T11:00:00+08:00", occurred_at: "2026-09-11T11:05:00+08:00" });
  svc.recordUsage({ usage_id: "U3", agreement_id: "A2", device_id: "D2", service_code: "COMPANION", start: "2026-09-12T10:00:00+08:00", end: "2026-09-12T12:00:00+08:00", occurred_at: "2026-09-12T12:05:00+08:00" });
  svc.confirmPeriod(FIN, "2026-09", "2026-09-30T18:00:00+08:00");
}

test("家庭只能看到本户明细", () => {
  const { svc } = boot();
  setupTwoHouseholds(svc);

  const view = svc.familyView(familyOf("H1"), { period: "2026-09" });
  assert.equal(view.household_id, "H1");
  assert.deepEqual(view.usages.map((u) => u.usage_id), ["U1", "U2"]);
  assert.ok(view.entries.every((e) => ["gov", "ltc", "fam-H1"].includes(e.funder_id)));
  assert.equal(view.totals.by_funder_cents.gov, 10000);
  assert.equal(view.totals.by_funder_cents.ltc, 5000);
  assert.equal(view.totals.due_from_family_cents, 17000); // 2000 + 15000

  const view2 = svc.familyView(familyOf("H2"), {});
  assert.deepEqual(view2.usages.map((u) => u.usage_id), ["U3"]);
  assert.equal(view2.totals.due_from_family_cents, 16000); // 24000 - ltc 8000

  // 越界访问他户、或以非家庭角色调用，一律拒绝
  assert.throws(() => svc.familyView(familyOf("H1"), { household_id: "H2" }), (err) => err.code === "ACCESS_DENIED");
  assert.throws(() => svc.familyView(funderOf("gov"), {}), (err) => err.code === "ACCESS_DENIED");
});

test("资助方只能查看自己承担的汇总", () => {
  const { svc } = boot();
  setupTwoHouseholds(svc);

  const gov = svc.funderView(funderOf("gov"), { period: "2026-09" });
  assert.equal(gov.periods["2026-09"].borne_cents, 10000);
  assert.deepEqual(Object.keys(gov.households), ["H1"]); // gov 与 H2 无关
  assert.equal(gov.caps[0].remaining_cents, 0); // 月上限 10000 已用尽
  assert.ok(!("usages" in gov), "资助方视图不含逐条用量明细");

  const ltc = svc.funderView(funderOf("ltc"), { period: "2026-09" });
  assert.equal(ltc.periods["2026-09"].borne_cents, 13000); // H1 的 5000 + H2 的 8000
  assert.equal(ltc.households["H1"].borne_cents, 5000);
  assert.equal(ltc.households["H2"].borne_cents, 8000);
  // 视图中不出现其他资助方的承担金额
  const serialized = JSON.stringify(ltc);
  assert.ok(!serialized.includes('"gov"'), "资助方视图泄露了其他资助方");

  assert.throws(() => svc.funderView(familyOf("H1"), {}), (err) => err.code === "ACCESS_DENIED");
});

test("审计视图证明每一小时由谁支付、剩余额度如何变化", () => {
  const { svc } = boot();
  setupTwoHouseholds(svc);

  const audit = svc.auditView(AUDIT, { household_id: "H1", period: "2026-09" });
  assert.equal(audit.usages.length, 2);
  for (const usage of audit.usages) {
    const paid = usage.payers.filter((p) => p.kind === "charge").reduce((a, p) => a + p.amount_cents, 0);
    assert.equal(paid, usage.amount_cents, `用量 ${usage.usage_id} 的支付方合计与应计费用不符`);
  }
  const u1 = audit.usages.find((u) => u.usage_id === "U1");
  assert.deepEqual(
    u1.payers.map((p) => [p.funder_id, p.amount_cents]),
    [["gov", 10000], ["fam-H1", 2000]],
  );

  // 剩余额度随每笔入账逐步变化
  const govSteps = audit.cap_evolution.gov.steps;
  assert.equal(audit.cap_evolution.gov.cap_cents, 10000);
  assert.deepEqual(govSteps.map((s) => s.remaining_after_cents), [0]);
  const ltcSteps = audit.cap_evolution.ltc.steps;
  assert.deepEqual(ltcSteps.map((s) => s.remaining_after_cents), [0]);
  assert.equal(audit.cap_evolution["fam-H1"].cap_cents, null); // 家庭自付不限额
  assert.ok(audit.cap_evolution["fam-H1"].steps.every((s) => s.remaining_after_cents === null));

  // 非审计角色不得调用
  assert.throws(() => svc.auditView(familyOf("H1"), { household_id: "H1" }), (err) => err.code === "ACCESS_DENIED");
  assert.throws(() => svc.auditView(funderOf("gov"), { household_id: "H1" }), (err) => err.code === "ACCESS_DENIED");
});
