import assert from "node:assert/strict";
import test from "node:test";

import { boot, setupStandard, entriesOf, centsOf, FIN } from "./helpers.js";

const rental = (id, household, device, from, to) => ({
  agreement_id: id,
  household_id: household,
  device_id: device,
  start: from,
  end: to,
  occurred_at: "2026-08-31T12:00:00+08:00",
});

test("同一设备并发占用必须拒绝", () => {
  const { svc } = boot();
  setupStandard(svc); // A1：D1 在 2026-09-01 ~ 2026-10-01 租给 H1
  assert.throws(
    () => svc.scheduleRental(rental("A2", "H2", "D1", "2026-09-15T00:00:00+08:00", "2026-09-20T00:00:00+08:00")),
    (err) => err.code === "DEVICE_OCCUPIED",
  );
  // 换一台设备则可以
  svc.scheduleRental(rental("A3", "H2", "D9", "2026-09-15T00:00:00+08:00", "2026-09-20T00:00:00+08:00"));
  // A1 提前退租后，D1 的时段被释放
  svc.closeRental({ agreement_id: "A1", end: "2026-09-10T00:00:00+08:00", occurred_at: "2026-09-09T18:00:00+08:00" });
  svc.scheduleRental(rental("A4", "H2", "D1", "2026-09-10T00:00:00+08:00", "2026-09-20T00:00:00+08:00"));
});

test("换机保留原租赁连续性", () => {
  const { svc } = boot();
  setupStandard(svc);
  // 占用 D3，验证换到被占用设备会被拒绝
  svc.scheduleRental(rental("A3", "H3", "D3", "2026-09-01T00:00:00+08:00", "2026-10-01T00:00:00+08:00"));
  assert.throws(
    () => svc.replaceDevice({ agreement_id: "A1", to_device_id: "D3", at: "2026-09-10T10:00:00+08:00", reason: "故障", occurred_at: "2026-09-10T10:05:00+08:00" }),
    (err) => err.code === "DEVICE_OCCUPIED",
  );

  const { from_device_id } = svc.replaceDevice({
    agreement_id: "A1", to_device_id: "D2", at: "2026-09-10T10:00:00+08:00",
    reason: "主机故障，临时换机", occurred_at: "2026-09-10T10:05:00+08:00",
  });
  assert.equal(from_device_id, "D1");

  // 换机后用量记在新设备上，原协议继续有效
  const u = svc.recordUsage({
    usage_id: "UR1", agreement_id: "A1", device_id: "D2", service_code: "COMPANION",
    start: "2026-09-10T11:00:00+08:00", end: "2026-09-10T12:00:00+08:00", occurred_at: "2026-09-10T12:05:00+08:00",
  });
  assert.equal(u.amount_cents, 12000);
  // 换机时刻起旧设备不再属于该协议
  assert.throws(
    () => svc.recordUsage({
      usage_id: "UR2", agreement_id: "A1", device_id: "D1", service_code: "COMPANION",
      start: "2026-09-10T10:30:00+08:00", end: "2026-09-10T11:00:00+08:00", occurred_at: "2026-09-10T11:05:00+08:00",
    }),
    (err) => err.code === "DEVICE_NOT_ASSIGNED",
  );
  // 旧设备从换机时刻起可租给其他户
  svc.scheduleRental(rental("A4", "H2", "D1", "2026-09-10T10:00:00+08:00", "2026-09-20T00:00:00+08:00"));
  // 原租赁时段不变：月末新设备上的用量照常入账
  const late = svc.recordUsage({
    usage_id: "UR3", agreement_id: "A1", device_id: "D2", service_code: "COMPANION",
    start: "2026-09-25T10:00:00+08:00", end: "2026-09-25T11:00:00+08:00", occurred_at: "2026-09-25T11:05:00+08:00",
  });
  assert.equal(late.amount_cents, 12000);
});

test("同一设备的重叠计量必须拒绝", () => {
  const { svc } = boot();
  setupStandard(svc);
  svc.recordUsage({
    usage_id: "U1", agreement_id: "A1", device_id: "D1", service_code: "COMPANION",
    start: "2026-09-10T10:00:00+08:00", end: "2026-09-10T11:00:00+08:00", occurred_at: "2026-09-10T11:05:00+08:00",
  });
  assert.throws(
    () => svc.recordUsage({
      usage_id: "U2", agreement_id: "A1", device_id: "D1", service_code: "COMPANION",
      start: "2026-09-10T10:30:00+08:00", end: "2026-09-10T11:30:00+08:00", occurred_at: "2026-09-10T11:35:00+08:00",
    }),
    (err) => err.code === "METERING_OVERLAP",
  );
  // 首尾相接（半开区间）不算重叠
  svc.recordUsage({
    usage_id: "U3", agreement_id: "A1", device_id: "D1", service_code: "COMPANION",
    start: "2026-09-10T11:00:00+08:00", end: "2026-09-10T12:00:00+08:00", occurred_at: "2026-09-10T12:05:00+08:00",
  });
});

test("设备停机改变应计费用：先停机后计量直接扣减", () => {
  const { svc } = boot();
  setupStandard(svc);
  svc.recordDowntime({
    downtime_id: "DT1", device_id: "D1",
    start: "2026-09-10T10:30:00+08:00", end: "2026-09-10T11:00:00+08:00",
    reason: "例行保养", occurred_at: "2026-09-10T09:00:00+08:00",
  });
  const u = svc.recordUsage({
    usage_id: "U1", agreement_id: "A1", device_id: "D1", service_code: "COMPANION",
    start: "2026-09-10T10:00:00+08:00", end: "2026-09-10T12:00:00+08:00", occurred_at: "2026-09-10T12:05:00+08:00",
  });
  // 120 分钟扣除 30 分钟停机，按 90 分钟计费
  assert.equal(u.amount_cents, 18000);
  assert.equal(centsOf(entriesOf(svc, "U1"), "gov"), 10000);
  assert.equal(centsOf(entriesOf(svc, "U1"), "fam-H1"), 8000);
});

test("设备停机改变应计费用：后登记停机生成冲正分录", () => {
  const { svc } = boot();
  setupStandard(svc);
  svc.recordUsage({
    usage_id: "U1", agreement_id: "A1", device_id: "D1", service_code: "COMPANION",
    start: "2026-09-10T10:00:00+08:00", end: "2026-09-10T12:00:00+08:00", occurred_at: "2026-09-10T12:05:00+08:00",
  });
  // 拆分时无停机：120 分钟 × 200 分/分钟 = 24000，gov 承担 10000、fam 承担 14000
  const corrections = svc.recordDowntime({
    downtime_id: "DT2", device_id: "D1",
    start: "2026-09-10T11:00:00+08:00", end: "2026-09-10T11:15:00+08:00",
    reason: "突发故障", occurred_at: "2026-09-10T15:00:00+08:00",
  });
  // 15 分钟 × 200 分/分钟 = 3000 分，按原拆分比例冲正：gov -1250、fam -1750
  assert.equal(corrections.reduce((a, e) => a + e.amount_cents, 0), -3000);
  assert.equal(centsOf(corrections, "gov"), -1250);
  assert.equal(centsOf(corrections, "fam-H1"), -1750);
  assert.ok(corrections.every((e) => e.kind === "correction" && e.period === "2026-09" && e.adjusts_entry_id));
  // 财务确认后，该用量的净额为 105 分钟 × 200 分/分钟 = 21000
  svc.confirmPeriod(FIN, "2026-09", "2026-09-30T18:00:00+08:00");
  const posted = entriesOf(svc, "U1").filter((e) => e.status === "posted");
  assert.equal(posted.reduce((a, e) => a + e.amount_cents, 0), 21000);
});

test("重叠停机时段按并集扣减，不重复冲正", () => {
  const { svc } = boot();
  setupStandard(svc);
  svc.recordUsage({
    usage_id: "U1", agreement_id: "A1", device_id: "D1", service_code: "COMPANION",
    start: "2026-09-10T10:00:00+08:00", end: "2026-09-10T12:00:00+08:00", occurred_at: "2026-09-10T12:05:00+08:00",
  });
  svc.recordDowntime({
    downtime_id: "DT1", device_id: "D1",
    start: "2026-09-10T10:30:00+08:00", end: "2026-09-10T11:00:00+08:00",
    reason: "保养", occurred_at: "2026-09-10T15:00:00+08:00",
  });
  const second = svc.recordDowntime({
    downtime_id: "DT2", device_id: "D1",
    start: "2026-09-10T10:45:00+08:00", end: "2026-09-10T11:15:00+08:00",
    reason: "保养延长", occurred_at: "2026-09-10T16:00:00+08:00",
  });
  // 第二段停机与第一段重叠 15 分钟，只有新增覆盖的 15 分钟产生冲正
  assert.equal(second.reduce((a, e) => a + e.amount_cents, 0), -3000);
  const all = entriesOf(svc, "U1");
  const correctionsTotal = all.filter((e) => e.kind === "correction").reduce((a, e) => a + e.amount_cents, 0);
  assert.equal(correctionsTotal, -9000); // 并集 45 分钟 × 200 分/分钟
});
