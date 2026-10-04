import { CoverResult } from "./cover.js";
import { Grid, interleave, keyInIntervals } from "./morton.js";

export interface IntervalLike {
  lo: string;
  hi: string;
}

export function toBigIntervals(intervals: ReadonlyArray<IntervalLike>) {
  return intervals.map((iv) => ({ lo: BigInt(iv.lo), hi: BigInt(iv.hi) }));
}

/** 判断键是否属于覆盖结果区间集合 */
export function isCoveredKey(intervals: ReadonlyArray<IntervalLike>, key: bigint): boolean {
  return keyInIntervals(key, toBigIntervals(intervals));
}

export interface BruteCheckReport {
  gridPoints: string;
  rectPoints: string;
  coveredPoints: string;
  falsePositive: string;
  falseNegative: string;
  outside: string;
  duplicatePoints: string;
  exact: boolean;
}

/**
 * 独立枚举网格中的每个点（仅适用于较小网格），
 * 用普通矩形半开包含判断与“区间成员”结果逐点比较。
 */
export function bruteForceCheck(
  grid: Grid,
  rect: { xmin: bigint; xmax: bigint; ymin: bigint; ymax: bigint },
  intervals: ReadonlyArray<IntervalLike>
): BruteCheckReport {
  if (grid.size > 4096n) {
    throw new Error(
      `bruteForceCheck 仅支持边长 <=4096 的网格（当前 ${grid.size.toString()}），以免枚举手误`
    );
  }
  const bigIv = toBigIntervals(intervals);
  let rectPoints = 0n;
  let coveredPoints = 0n;
  let falsePositive = 0n;
  let falseNegative = 0n;
  let outside = 0n;

  for (let x = 0n; x < grid.size; x++) {
    for (let y = 0n; y < grid.size; y++) {
      const inRect = x >= rect.xmin && x < rect.xmax && y >= rect.ymin && y < rect.ymax;
      const inCover = keyInIntervals(interleave(x, y), bigIv);
      if (inRect) rectPoints++;
      else outside++;
      if (inCover) coveredPoints++;
      if (inCover && !inRect) falsePositive++;
      if (inRect && !inCover) falseNegative++;
    }
  }

  // 区间不相交检查（已合并相邻后应互不重叠）
  let duplicatePoints = 0n;
  for (let i = 1; i < bigIv.length; i++) {
    const prev = bigIv[i - 1]!;
    const cur = bigIv[i]!;
    if (cur.lo <= prev.hi) {
      duplicatePoints += prev.hi - cur.lo + 1n;
    }
  }

  return {
    gridPoints: (grid.size * grid.size).toString(),
    rectPoints: rectPoints.toString(),
    coveredPoints: coveredPoints.toString(),
    falsePositive: falsePositive.toString(),
    falseNegative: falseNegative.toString(),
    outside: outside.toString(),
    duplicatePoints: duplicatePoints.toString(),
    exact: falsePositive === 0n && falseNegative === 0n && duplicatePoints === 0n,
  };
}

export function intervalPointCount(result: CoverResult): bigint {
  return result.intervals.reduce((acc, iv) => acc + (BigInt(iv.hi) - BigInt(iv.lo) + 1n), 0n);
}
