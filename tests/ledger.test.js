import assert from "node:assert/strict";
import test from "node:test";

import { SettlementService } from "../src/service.js";
import { boot, setupStandard, entriesOf, centsOf, FIN, familyOf, funderOf } from "./helpers.js";

function usageOn(id, day) {
  return {
    usage_id: id,
    agreement_id: "A1",
    device_id: "D1",
    service_code: "COMPANION",
    start: `2026-09-${day}T10:00:00+08:00`,
    end: `2026-09-${day}T11:00:00+08:00`,
    occurred_at: `2026-09-${day}T11:05:00+08:00`,
  };
}

test("争议只冻结对应分录，解除时可更正净额", () => {
  const { store, svc } = boot();
  setupStandard(svc);
  svc.recordUsage(usageOn("U1", "10"));
  svc.recordUsage({ ...usageOn("U2", "11"), service_code: "REHAB" });
  svc.confirmPeriod(FIN, "2026-09", "2026-09-30T18:00:00+08:00");

  const govEntry = entriesOf(svc, "U1").find((e) => e.funder_id === "gov");
  const famEntry = entriesOf(svc, "U1").find((e) => e.funder_id === "fam-H1");

  // 无关角色不能冻结他人分录
  assert.throws(
    () => svc.raiseDispute(funderOf("ltc"), govEntry.entry_id, "金额存疑", "2026-09-25T10:00:00+08:00"),
    (err) => err.code === "ACCESS_DENIED",
  );
  assert.throws(
    () => svc.raiseDispute(familyOf("H2"), govEntry.entry_id, "金额存疑", "2026-09-25T10:00:00+08:00"),
    (err) => err.code === "ACCESS_DENIED",
  );

  // 本户家庭可以冻结；冻结只影响该分录
  svc.raiseDispute(familyOf("H1"), govEntry.entry_id, "老人当天未使用", "2026-09-25T10:00:00+08:00");
  assert.equal(svc.getEntry(govEntry.entry_id).frozen, true);
  assert.equal(svc.getEntry(famEntry.entry_id).frozen, false);

  // 解除并更正为 8000：生成 -2000 的同期冲正分录
  const fixes = svc.resolveDispute(FIN, govEntry.entry_id, { action: "correct", corrected_cents: 8000, reason: "复核后部分认可" }, "2026-09-26T09:00:00+08:00");
  assert.equal(svc.getEntry(govEntry.entry_id).frozen, false);
  assert.equal(fixes.length, 1);
  assert.equal(fixes[0].amount_cents, -2000);
  assert.equal(fixes[0].kind, "correction");
  svc.confirmPeriod(FIN, "2026-09", "2026-09-30T19:00:00+08:00");
  const govNet = entriesOf(svc, "U1").filter((e) => e.funder_id === "gov" && e.status === "posted").reduce((a, e) => a + e.amount_cents, 0);
  assert.equal(govNet, 8000);

  // 服务事实不回滚：两条用量记录原样保留，没有任何事件被改写
  const usages = store.byType("USAGE_RECORDED");
  assert.equal(usages.length, 2);
  assert.deepEqual(
    usages.map((u) => [u.payload.usage_id, u.payload.amount_cents]),
    [["U1", 12000], ["U2", 20000]],
  );
});

test("迟到回执只调整尚未封账的周期", () => {
  const { svc } = boot();
  setupStandard(svc);
  svc.recordUsage(usageOn("U1", "10"));
  svc.confirmPeriod(FIN, "2026-09", "2026-09-30T18:00:00+08:00");
  const govEntry = entriesOf(svc, "U1").find((e) => e.funder_id === "gov");

  const fix = svc.recordReceipt(funderOf("gov"), govEntry.entry_id, 9000, "补贴核算后实际承担 9000", "2026-09-28T10:00:00+08:00");
  assert.equal(fix.kind, "correction");
  assert.equal(fix.period, "2026-09");
  assert.equal(fix.amount_cents, -1000);
  assert.equal(fix.adjusts_entry_id, govEntry.entry_id);
  assert.match(fix.reason, /迟到回执/);

  // 回执金额与净额一致时不产生分录
  svc.confirmPeriod(FIN, "2026-09", "2026-09-30T19:00:00+08:00");
  assert.equal(svc.recordReceipt(funderOf("gov"), govEntry.entry_id, 9000, "重复回执", "2026-09-29T10:00:00+08:00"), null);
});

test("已封账周期追加差额与原因，原周期分录不动", () => {
  const { svc } = boot();
  setupStandard(svc);
  svc.recordUsage(usageOn("U1", "10"));
  svc.confirmPeriod(FIN, "2026-09", "2026-09-30T18:00:00+08:00");
  svc.sealPeriod(FIN, "2026-09", "2026-10-01T09:00:00+08:00");
  assert.equal(svc.periodStatus("2026-09"), "sealed");

  // 已封账周期不再接受新的计量
  assert.throws(() => svc.recordUsage(usageOn("U2", "20")), (err) => err.code === "PERIOD_SEALED");

  const govEntry = entriesOf(svc, "U1").find((e) => e.funder_id === "gov");
  const fix = svc.recordReceipt(FIN, govEntry.entry_id, 9000, "补贴季度清算后少付 1000", "2026-10-05T10:00:00+08:00");
  assert.equal(fix.kind, "adjustment");
  assert.equal(fix.period, "2026-10");
  assert.equal(fix.amount_cents, -1000);
  assert.equal(fix.adjusts_entry_id, govEntry.entry_id);
  assert.match(fix.reason, /迟到回执/);

  // 原周期分录保持原样
  assert.equal(svc.getEntry(govEntry.entry_id).amount_cents, 10000);
  assert.equal(svc.getEntry(govEntry.entry_id).status, "posted");
});

test("封账前须确认全部分录，封账生成对账单快照", () => {
  const { svc } = boot();
  setupStandard(svc);
  svc.recordUsage(usageOn("U1", "10"));
  assert.throws(() => svc.sealPeriod(FIN, "2026-09", "2026-10-01T09:00:00+08:00"), (err) => err.code === "PROPOSED_ENTRIES_REMAIN");
  svc.confirmPeriod(FIN, "2026-09", "2026-09-30T18:00:00+08:00");
  svc.sealPeriod(FIN, "2026-09", "2026-10-01T09:00:00+08:00");
  assert.equal(svc.periodStatus("2026-09"), "sealed");
  assert.deepEqual(svc.statementOf("2026-09"), { gov: 10000, "fam-H1": 2000 });
  assert.throws(() => svc.sealPeriod(FIN, "2026-09", "2026-10-02T09:00:00+08:00"), (err) => err.code === "PERIOD_SEALED");
});

test("服务恢复后继续未完成的封账", () => {
  const { store, svc } = boot();
  setupStandard(svc);
  svc.recordUsage(usageOn("U1", "10"));
  svc.confirmPeriod(FIN, "2026-09", "2026-09-30T18:00:00+08:00");

  // 封账进行到一半宕机：PERIOD_SEALING_STARTED 已落库，后续步骤未完成
  const crashed = new SettlementService(store, {
    hooks: {
      afterEvent: (event) => {
        if (event.event_type === "PERIOD_SEALING_STARTED") throw new Error("模拟宕机");
      },
    },
  });
  assert.throws(() => crashed.sealPeriod(FIN, "2026-09", "2026-10-01T09:00:00+08:00"), /模拟宕机/);

  // 新实例从事件存储重建状态，续跑完成封账
  const recovered = new SettlementService(store);
  const resumed = recovered.recover("2026-10-01T09:05:00+08:00");
  assert.deepEqual(resumed.sealed, ["2026-09"]);
  assert.equal(recovered.periodStatus("2026-09"), "sealed");
  assert.deepEqual(recovered.statementOf("2026-09"), { gov: 10000, "fam-H1": 2000 });
});

test("服务恢复后继续未兑付的退款", () => {
  const { store, svc } = boot();
  setupStandard(svc);
  svc.recordUsage(usageOn("U1", "10"));
  svc.confirmPeriod(FIN, "2026-09", "2026-09-30T18:00:00+08:00");

  const crashed = new SettlementService(store, {
    hooks: {
      afterEvent: (event) => {
        if (event.event_type === "REFUND_REQUESTED") throw new Error("模拟宕机");
      },
    },
  });
  assert.throws(
    () =>
      crashed.requestRefund(FIN, {
        household_id: "H1",
        funder_id: "fam-H1",
        amount_cents: 500,
        reason: "停机期间多收，退回家庭",
        occurred_at: "2026-09-20T10:00:00+08:00",
      }),
    /模拟宕机/,
  );

  const recovered = new SettlementService(store);
  const resumed = recovered.recover("2026-09-20T11:00:00+08:00");
  assert.equal(resumed.refunds_completed.length, 1);
  const refund = recovered.getEntry(resumed.refunds_completed[0]);
  assert.equal(refund.refund_state, "completed");
  assert.equal(refund.amount_cents, -500);
  // 家庭视图中应付款随之减少
  const view = recovered.familyView(familyOf("H1"), {});
  assert.equal(view.totals.by_funder_cents["fam-H1"], 1500);
});
