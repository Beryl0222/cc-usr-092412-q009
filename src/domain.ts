/** 养老机器人共享结算台使用的领域事件信封。 */
export interface DomainEvent {
  event_id: string;
  event_type: string;
  aggregate_type: string;
  aggregate_id: string;
  occurred_at: string;
  version: number;
  summary: string;
  payload?: Record<string, unknown>;
}

/** 资助方规则：priority 越小越先承担；cap_cents 为 null 表示不限额兜底（通常为家庭自付）。 */
export interface FunderRule {
  funder_id: string;
  /** government_subsidy（政府补贴）| ltc_account（长期护理账户）| family_self_pay（家庭自付） */
  kind: string;
  priority: number;
  cap_cents: number | null;
  /** cap_cents 非空时必填：month 按自然月、total 累计。 */
  cap_period: "month" | "total" | null;
  /** 适用服务："*" 表示全部服务。 */
  services: "*" | string[];
}

export interface EligibilityAssessedPayload {
  decision_id: string;
  household_id: string;
  effective_from: string;
  funders: FunderRule[];
  reason?: string;
}

export interface ServicePackagePublishedPayload {
  package_id: string;
  effective_from: string;
  /** 服务编码 → 单价（分/小时）。 */
  items: Record<string, { unit_price_cents: number; unit: "hour" }>;
}

export interface RentalPeriodScheduledPayload {
  household_id: string;
  device_id: string;
  start: string;
  end: string;
}

export interface DeviceReplacedPayload {
  from_device_id: string;
  to_device_id: string;
  at: string;
  reason: string;
}

export interface UsageRecordedPayload {
  usage_id: string;
  agreement_id: string;
  household_id: string;
  service_code: string;
  start: string;
  end: string;
  minutes: number;
  billable_minutes: number;
  amount_cents: number;
}

export interface DowntimeRecordedPayload {
  downtime_id: string;
  start: string;
  end: string;
  reason: string;
}

/** 台账分录：金额带符号，负数为冲减；同一用量按资助方各一条，合计等于应计费用。 */
export interface LedgerEntry {
  entry_id: string;
  period: string;
  household_id: string;
  agreement_id: string | null;
  usage_id: string | null;
  funder_id: string;
  funder_kind: string;
  service_code: string | null;
  amount_cents: number;
  /** charge 费用 | correction 同期冲正 | adjustment 跨期追加 | refund 退款 */
  kind: "charge" | "correction" | "adjustment" | "refund";
  status: "proposed" | "posted";
  frozen: boolean;
  adjusts_entry_id?: string | null;
  reason?: string | null;
  refund_state?: "requested" | "completed";
  posted_at?: string | null;
}

export type Principal =
  | { role: "family"; household_id: string }
  | { role: "funder"; funder_id: string }
  | { role: "finance" }
  | { role: "audit" };
