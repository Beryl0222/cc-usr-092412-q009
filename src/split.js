/**
 * 费用拆分：按资助方优先级瀑布式分摊金额。
 * 每个资助方只承担自己剩余额度内的部分，绝不突破上限；
 * 全部分配完后仍有剩余的，作为未覆盖余额交给调用方处理。
 *
 * @param {number} grossCents 待拆分金额（分）
 * @param {Array<{funder_id: string, remaining_cents: number}>} funders 按优先级升序排列的资助方及其剩余额度
 * @returns {{allocations: Array<{funder_id: string, amount_cents: number}>, uncovered_cents: number}}
 */
export function allocateAmount(grossCents, funders) {
  let remaining = grossCents;
  const allocations = [];
  for (const funder of funders) {
    if (remaining <= 0) break;
    const room = Math.max(0, funder.remaining_cents);
    const take = Math.min(room, remaining);
    if (take > 0) {
      allocations.push({ funder_id: funder.funder_id, amount_cents: take });
      remaining -= take;
    }
  }
  return { allocations, uncovered_cents: remaining };
}
