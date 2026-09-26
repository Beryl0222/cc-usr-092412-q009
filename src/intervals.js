import { fail } from "./errors.js";

/** 半开区间 [start, end) 上的时间工具，所有比较基于毫秒。 */

export function toMs(iso, field = "occurred_at") {
  if (typeof iso !== "string") fail("INVALID_TIME", `${field} 必须是 ISO 时间字符串`);
  const t = Date.parse(iso);
  if (Number.isNaN(t)) fail("INVALID_TIME", `${field} 不是有效时间：${iso}`);
  return t;
}

export function minutesBetween(start, end) {
  const s = toMs(start, "start");
  const e = toMs(end, "end");
  if (e <= s) fail("INVALID_INTERVAL", `时段结束必须晚于开始：${start} ~ ${end}`);
  return Math.round((e - s) / 60000);
}

export function overlapsInterval(aStart, aEnd, bStart, bEnd) {
  return toMs(aStart, "start") < toMs(bEnd, "end") && toMs(bStart, "start") < toMs(aEnd, "end");
}

export function intersectionMinutes(aStart, aEnd, bStart, bEnd) {
  const s = Math.max(toMs(aStart, "start"), toMs(bStart, "start"));
  const e = Math.min(toMs(aEnd, "end"), toMs(bEnd, "end"));
  return e > s ? Math.round((e - s) / 60000) : 0;
}

/** 一组区间在 [withinStart, withinEnd) 内的并集覆盖分钟数，用于停机时间去重。 */
export function unionCoverageMinutes(intervals, withinStart, withinEnd) {
  const lo = toMs(withinStart, "start");
  const hi = toMs(withinEnd, "end");
  const clipped = intervals
    .map(([s, e]) => [Math.max(toMs(s, "start"), lo), Math.min(toMs(e, "end"), hi)])
    .filter(([s, e]) => e > s)
    .sort((a, b) => a[0] - b[0]);
  let total = 0;
  let curS = null;
  let curE = null;
  for (const [s, e] of clipped) {
    if (curS === null) {
      curS = s;
      curE = e;
    } else if (s <= curE) {
      curE = Math.max(curE, e);
    } else {
      total += curE - curS;
      curS = s;
      curE = e;
    }
  }
  if (curS !== null) total += curE - curS;
  return Math.round(total / 60000);
}

/** 结算周期取时间字符串所在的自然月（按业务方本地历法，即字符串本身的前 7 位）。 */
export function periodOf(iso) {
  toMs(iso);
  return iso.slice(0, 7);
}
