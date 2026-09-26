import { EventStore } from "../src/store.js";
import { SettlementService } from "../src/service.js";

export const FIN = { role: "finance" };
export const AUDIT = { role: "audit" };
export const familyOf = (householdId) => ({ role: "family", household_id: householdId });
export const funderOf = (funderId) => ({ role: "funder", funder_id: funderId });

export function boot(options) {
  const store = new EventStore();
  const svc = new SettlementService(store, options);
  return { store, svc };
}

/**
 * 标准环境：服务包（陪伴照护 120 元/小时、康复训练 200 元/小时），
 * 户 H1 的资格（政府补贴月上限 100 元优先承担，长期护理账户月上限 50 元仅适用康复训练，
 * 家庭自付不限额兜底），设备 D1 整个 9 月租给 H1。
 */
export function setupStandard(svc) {
  svc.publishPackage({
    package_id: "pkg-basic",
    effective_from: "2026-09-01T00:00:00+08:00",
    occurred_at: "2026-08-31T12:00:00+08:00",
    items: {
      COMPANION: { unit_price_cents: 12000, unit: "hour" },
      REHAB: { unit_price_cents: 20000, unit: "hour" },
    },
  });
  svc.assessEligibility({
    household_id: "H1",
    effective_from: "2026-09-01T00:00:00+08:00",
    occurred_at: "2026-08-31T12:00:00+08:00",
    funders: [
      { funder_id: "gov", kind: "government_subsidy", priority: 1, cap_cents: 10000, cap_period: "month", services: ["COMPANION", "REHAB"] },
      { funder_id: "ltc", kind: "ltc_account", priority: 2, cap_cents: 5000, cap_period: "month", services: ["REHAB"] },
      { funder_id: "fam-H1", kind: "family_self_pay", priority: 3, cap_cents: null, cap_period: null, services: "*" },
    ],
  });
  svc.scheduleRental({
    agreement_id: "A1",
    household_id: "H1",
    device_id: "D1",
    start: "2026-09-01T00:00:00+08:00",
    end: "2026-10-01T00:00:00+08:00",
    occurred_at: "2026-08-31T12:00:00+08:00",
  });
}

export function entriesOf(svc, usageId) {
  return svc.listEntries({}).filter((e) => e.usage_id === usageId);
}

export function centsOf(entries, funderId) {
  return entries.filter((e) => e.funder_id === funderId).reduce((a, e) => a + e.amount_cents, 0);
}
