import assert from "node:assert/strict";
import test from "node:test";

import { AGGREGATE_TYPES, EVENT_TYPES, validateEvent } from "../src/validator.js";

function envelope(overrides = {}) {
  return {
    event_id: "evt-000001",
    event_type: "USAGE_RECORDED",
    aggregate_type: "robot_device",
    aggregate_id: "robot-01",
    occurred_at: "2026-09-20T18:00:00+08:00",
    version: 1,
    summary: "记录设备使用计量",
    ...overrides,
  };
}

test("全部约定的事件类型与聚合类型均可通过校验", () => {
  for (const event_type of EVENT_TYPES) {
    assert.deepEqual(validateEvent(envelope({ event_type })), [], `事件类型 ${event_type} 应被接受`);
  }
  for (const aggregate_type of AGGREGATE_TYPES) {
    assert.deepEqual(validateEvent(envelope({ aggregate_type })), [], `聚合类型 ${aggregate_type} 应被接受`);
  }
});

test("约定之外的事件类型与聚合类型被拒绝", () => {
  assert.deepEqual(validateEvent(envelope({ event_type: "MONEY_PRINTED" })), ["event_type 不在约定范围内：MONEY_PRINTED"]);
  assert.deepEqual(validateEvent(envelope({ aggregate_type: "bank_account" })), ["aggregate_type 不在约定范围内：bank_account"]);
});

test("缺少字段与非法版本号仍按原约定报告", () => {
  assert.deepEqual(validateEvent({}), [
    "缺少字段：event_id",
    "缺少字段：event_type",
    "缺少字段：aggregate_type",
    "缺少字段：aggregate_id",
    "缺少字段：occurred_at",
    "缺少字段：version",
    "缺少字段：summary",
  ]);
  assert.deepEqual(validateEvent(envelope({ version: 0 })), ["version 必须是正整数"]);
});
