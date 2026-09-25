const required = ["event_id", "event_type", "aggregate_type", "aggregate_id", "occurred_at", "version", "summary"];

/** 与 contracts/domain.schema.json 中的枚举保持一致。 */
export const EVENT_TYPES = [
  "FUNDER_REGISTERED",
  "ELIGIBILITY_ASSESSED",
  "SERVICE_PACKAGE_REGISTERED",
  "RENTAL_OPENED",
  "DEVICE_DELIVERED",
  "DEVICE_REPLACED",
  "DOWNTIME_RECORDED",
  "USAGE_RECORDED",
  "CHARGE_ENTRIES_DRAFTED",
  "CHARGES_CONFIRMED",
  "PERIOD_CLOSING_STARTED",
  "CHARGE_ENTRIES_POSTED",
  "PERIOD_CLOSED",
  "ADJUSTMENT_APPENDED",
  "DISPUTE_RAISED",
  "DISPUTE_RESOLVED",
  "REFUND_REQUESTED",
  "REFUND_PAID",
  "STATEMENT_SETTLED",
];

export const AGGREGATE_TYPES = [
  "care_recipient",
  "robot_device",
  "rental_agreement",
  "funding_statement",
  "service_package",
  "funder_account",
  "dispute_case",
  "refund_obligation",
];

export function validateEvent(record) {
  const errors = required.filter((name) => !(name in record)).map((name) => `缺少字段：${name}`);
  if ("version" in record && (!Number.isInteger(record.version) || record.version < 1)) errors.push("version 必须是正整数");
  if ("event_type" in record && !EVENT_TYPES.includes(record.event_type)) errors.push(`event_type 不在约定范围内：${record.event_type}`);
  if ("aggregate_type" in record && !AGGREGATE_TYPES.includes(record.aggregate_type)) {
    errors.push(`aggregate_type 不在约定范围内：${record.aggregate_type}`);
  }
  return errors;
}
