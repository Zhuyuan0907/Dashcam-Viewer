/**
 * 數值小工具 —— 集中重複的整數夾制(原本 trips/ops route 各抄一份)。
 */

/** 把 query 字串解析成整數並夾在 [min,max];缺值或非數字回 dflt。 */
export function clampInt(raw: string | undefined, dflt: number, min: number, max: number): number {
  if (raw === undefined) return dflt;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, n));
}
