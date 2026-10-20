/**
 * 服务评价（D-54）：接待结束时买家给服务打 1–5 星，由结束时的满意度（0–100，后台观察员评估）换算。
 * 分界和买家给商品留评的星级同一套；满意率 = 4 星和 5 星的占比。纯函数，无数据库。
 */
export function starsFromSatisfaction(satisfaction: number): number {
  if (satisfaction >= 85) return 5;
  if (satisfaction >= 70) return 4;
  if (satisfaction >= 45) return 3;
  if (satisfaction >= 25) return 2;
  return 1;
}

/** 算满意的星级下限：4 星及以上 */
export const SATISFIED_STARS = 4;

export interface RatingSummary {
  /** 5 星到 1 星各多少次 */
  counts: [number, number, number, number, number];
  total: number;
  /** 4–5 星的次数 */
  satisfied: number;
  /** 满意率（%），没有评价时为 null */
  rate: number | null;
  /** 平均星级（一位小数），没有评价时为 null */
  average: number | null;
}

export function summarizeRatings(stars: number[]): RatingSummary {
  const counts: [number, number, number, number, number] = [0, 0, 0, 0, 0];
  let sum = 0;
  for (const value of stars) {
    const star = Math.min(5, Math.max(1, Math.round(value)));
    const index = 5 - star;
    counts[index] = (counts[index] ?? 0) + 1;
    sum += star;
  }
  const total = stars.length;
  const satisfied = counts[0] + counts[1];
  return {
    counts,
    total,
    satisfied,
    rate: total ? Math.round((satisfied / total) * 100) : null,
    average: total ? Math.round((sum / total) * 10) / 10 : null,
  };
}
