/** 养老机器人共享结算台使用的领域事件信封。 */
export interface DomainEvent {
  event_id: string;
  event_type: string;
  aggregate_type: string;
  aggregate_id: string;
  occurred_at: string;
  version: number;
  summary: string;
  payload?: unknown;
}

/** 资助方类别：政府补贴、长期护理账户、家庭自付。 */
export type FunderKind = "subsidy" | "ltc" | "family_self_pay";

export interface Funder {
  funder_id: string;
  name: string;
  kind: FunderKind;
  /** 数值小者优先承担费用。 */
  priority: number;
}

/** 资格决定的一个版本：某老人在某资助方下的月度额度与适用服务。 */
export interface EligibilityRecord {
  effective_from: string;
  effective_to: string | null;
  monthly_cap_cents: number;
  covered_services: string[];
  decided_by: string;
}

/** 服务包的一个版本：服务项单价（分/小时）与各资助方覆盖的服务项。 */
export interface ServicePackageRecord {
  effective_from: string;
  effective_to: string | null;
  items: Record<string, number>;
  coverage: Record<string, string[]>;
}

export interface DeviceAssignment {
  device_id: string;
  from: string;
  to: string | null;
}

/** 租赁协议：换机只追加设备分配链，协议本身不变，租赁连续性保留。 */
export interface RentalAgreement {
  agreement_id: string;
  household_id: string;
  recipient_id: string;
  opened_at: string;
  assignments: DeviceAssignment[];
}

/** 计量记录中一段可计费片段（已扣除停机、已按账期切开）。 */
export interface UsagePiece {
  start: string;
  end: string;
  service_period: string;
  gross_cents: number;
  price_cents_per_hour: number;
}

export interface UsageRecord {
  usage_id: string;
  agreement_id: string;
  device_id: string;
  service_code: string;
  package_id: string;
  start: string;
  end: string;
  pieces: UsagePiece[];
  status: string;
  recorded_at: string;
}

export type EntryStatus = "draft" | "confirmed" | "posted" | "frozen" | "reversed";

/**
 * 费用分录。booking_period 为入账周期，service_period 为服务发生周期（额度按它核算）；
 * 迟到回执与停机冲减产生 kind = "adjustment" 的差额分录并注明原因。
 */
export interface ChargeEntry {
  entry_id: string;
  recipient_id: string;
  household_id: string;
  agreement_id: string;
  usage_id: string | null;
  piece_index: number | null;
  service_code: string | null;
  funder_id: string;
  kind: "charge" | "adjustment";
  reason: string | null;
  booking_period: string;
  service_period: string;
  service_start: string | null;
  service_end: string | null;
  billable_hours: number | null;
  amount_cents: number;
  status: EntryStatus;
  prev_status: EntryStatus | null;
  seq: number;
}

export interface StatementPeriod {
  recipient_id: string;
  period: string;
  status: "open" | "closing" | "closed";
  totals: Record<string, number> | null;
}

export interface DisputeCase {
  dispute_id: string;
  entry_ids: string[];
  reason: string;
  raised_by: string;
  status: "open" | "resolved";
  resolution: { mode: "release" | "uphold"; reason: string | null } | null;
}

export interface RefundObligation {
  refund_id: string;
  recipient_id: string;
  funder_id: string;
  amount_cents: number;
  booking_period: string;
  reason: string;
  status: "pending" | "paid";
}

export type PrincipalRole = "family" | "funder" | "finance" | "audit";

/** 调用方身份：视图与财务操作按角色隔离。 */
export interface Principal {
  role: PrincipalRole;
  household_id?: string;
  funder_id?: string;
}
