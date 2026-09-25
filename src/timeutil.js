/**
 * 时间工具：所有计算以时间戳字符串中的本地墙钟时间为准。
 * 账期（月度）按墙钟时间归属，避免时区换算把月末最后一小时划到邻月。
 */

/** 把 ISO 字符串中的墙钟时间解析为毫秒数（忽略时区偏移，仅用于区间算术）。 */
export function parseLocal(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?/.exec(iso);
  if (!m) throw new Error(`无法解析时间：${iso}`);
  const [, y, mo, d, h, mi, s = "0", ms = "0"] = m;
  return Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s), Number(ms.padEnd(3, "0")));
}

/** 毫秒数转回 ISO 墙钟字符串。 */
export function isoOfMs(ms) {
  return new Date(ms).toISOString();
}

/** 毫秒数所属账期，格式 YYYY-MM。 */
export function periodOfMs(ms) {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** ISO 字符串所属账期。 */
export function periodOfIso(iso) {
  return periodOfMs(parseLocal(iso));
}

/** 账期起始毫秒数。 */
export function monthStartMs(period) {
  const [y, m] = period.split("-").map(Number);
  return Date.UTC(y, m - 1, 1);
}

/** 账期结束毫秒数（次月一日零点的开区间端点）。 */
export function monthEndMs(period) {
  const [y, m] = period.split("-").map(Number);
  return Date.UTC(y, m, 1);
}

/** 两个半开区间 [s, e) 是否重叠。 */
export function overlaps(s1, e1, s2, e2) {
  return s1 < e2 && s2 < e1;
}

/** 从基准区间集合中扣除若干停机区间，返回剩余可计费区间。 */
export function subtractIntervals(base, cuts) {
  let result = base.map(([s, e]) => [s, e]);
  for (const [cs, ce] of cuts) {
    const next = [];
    for (const [s, e] of result) {
      if (!overlaps(s, e, cs, ce)) {
        next.push([s, e]);
        continue;
      }
      if (s < cs) next.push([s, cs]);
      if (ce < e) next.push([ce, e]);
    }
    result = next;
  }
  return result.filter(([s, e]) => e > s);
}

/** 把区间按账期边界切成连续片段，每片完整落在同一个账期内。 */
export function splitByMonth(startMs, endMs) {
  const pieces = [];
  let cursor = startMs;
  while (cursor < endMs) {
    const boundary = monthEndMs(periodOfMs(cursor));
    const pieceEnd = Math.min(boundary, endMs);
    pieces.push([cursor, pieceEnd]);
    cursor = pieceEnd;
  }
  return pieces;
}

/** 区间小时数（可为小数）。 */
export function hoursBetween(startMs, endMs) {
  return (endMs - startMs) / 3600000;
}
