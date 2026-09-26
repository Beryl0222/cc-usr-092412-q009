export const EVENT_TYPES = [
  "ELIGIBILITY_ASSESSED",
  "SERVICE_PACKAGE_PUBLISHED",
  "RENTAL_PERIOD_SCHEDULED",
  "DEVICE_DELIVERED",
  "DEVICE_REPLACED",
  "RENTAL_PERIOD_CLOSED",
  "USAGE_RECORDED",
  "DOWNTIME_RECORDED",
  "ENTRY_PROPOSED",
  "ENTRY_POSTED",
  "ENTRY_DISPUTED",
  "ENTRY_DISPUTE_RESOLVED",
  "PERIOD_SEALING_STARTED",
  "PERIOD_SEALED",
  "STATEMENT_SETTLED",
  "REFUND_REQUESTED",
  "REFUND_COMPLETED",
];

export const AGGREGATE_TYPES = [
  "care_recipient",
  "robot_device",
  "rental_agreement",
  "funding_statement",
  "service_package",
  "ledger_entry",
  "billing_period",
];

const required = ["event_id", "event_type", "aggregate_type", "aggregate_id", "occurred_at", "version", "summary"];

export function validateEvent(record) {
  const errors = required.filter((name) => !(name in record)).map((name) => `缺少字段：${name}`);
  if ("version" in record && (!Number.isInteger(record.version) || record.version < 1)) errors.push("version 必须是正整数");
  if ("event_id" in record && (typeof record.event_id !== "string" || record.event_id.length === 0)) errors.push("event_id 必须是非空字符串");
  if ("aggregate_id" in record && (typeof record.aggregate_id !== "string" || record.aggregate_id.length === 0)) errors.push("aggregate_id 必须是非空字符串");
  if ("summary" in record && (typeof record.summary !== "string" || record.summary.length === 0)) errors.push("summary 必须是非空字符串");
  if ("event_type" in record && !EVENT_TYPES.includes(record.event_type)) errors.push(`未知事件类型：${record.event_type}`);
  if ("aggregate_type" in record && !AGGREGATE_TYPES.includes(record.aggregate_type)) errors.push(`未知聚合类型：${record.aggregate_type}`);
  if ("occurred_at" in record && (typeof record.occurred_at !== "string" || Number.isNaN(Date.parse(record.occurred_at)))) errors.push("occurred_at 必须是有效时间");
  if ("payload" in record && (typeof record.payload !== "object" || record.payload === null || Array.isArray(record.payload))) errors.push("payload 必须是对象");
  return errors;
}
