import { fail } from "./errors.js";

export function coversService(rule, serviceCode) {
  return rule.services === "*" || (Array.isArray(rule.services) && rule.services.includes(serviceCode));
}

/**
 * 按优先级瀑布拆分一笔费用：priority 小者先承担，任一资助方不超过其剩余额度，
 * 每一分钱只落到一个资助方。usedAmount(rule) 返回该规则额度口径下已占用的分。
 */
export function allocateCharges({ amount_cents, rules, usedAmount, service_code }) {
  const ordered = [...rules].sort(
    (a, b) => a.priority - b.priority || String(a.funder_id).localeCompare(String(b.funder_id)),
  );
  let remaining = amount_cents;
  const out = [];
  for (const rule of ordered) {
    if (remaining <= 0) break;
    if (!coversService(rule, service_code)) continue;
    const avail = rule.cap_cents == null ? remaining : Math.max(0, rule.cap_cents - usedAmount(rule));
    const take = Math.min(remaining, avail);
    if (take <= 0) continue;
    out.push({ funder_id: rule.funder_id, funder_kind: rule.kind, amount_cents: take });
    remaining -= take;
  }
  if (remaining > 0) fail("CAP_EXCEEDED", `资助方额度不足且无兜底方，剩余 ${remaining} 分无法分摊`);
  return out;
}

/** 按权重把总额拆成若干份（最大余数法，同余数按下标，结果确定）。 */
export function distributeByWeight(totalCents, weights) {
  const sum = weights.reduce((a, b) => a + b, 0);
  if (sum <= 0) return weights.map(() => 0);
  const raw = weights.map((w) => (totalCents * w) / sum);
  const floors = raw.map((x) => Math.floor(x));
  let rest = totalCents - floors.reduce((a, b) => a + b, 0);
  const order = raw.map((x, i) => [x - Math.floor(x), i]).sort((a, b) => b[0] - a[0] || a[1] - b[1]);
  for (const [, i] of order) {
    if (rest <= 0) break;
    floors[i] += 1;
    rest -= 1;
  }
  return floors;
}
