// 矩形区间覆盖：按 Morton 前缀递归遍历四叉树。
// 子块完全在外则跳过；完全包含则输出连续键区间；部分相交则细分。
import { ApiError, gridSize, validateBits } from "./morton";

export interface Rect {
  xmin: number;
  ymin: number;
  xmax: number;
  ymax: number;
}

export interface Budget {
  maxDepth?: number;
  maxVisited?: number;
  maxIntervals?: number;
}

export interface IntervalInfo {
  start: string;
  end: string;
  level: number;
  prefix: string;
  blockX: number;
  blockY: number;
  blockSize: number;
  reason: string;
}

export interface CoverResult {
  status: "complete" | "incomplete";
  incompleteReason?: string;
  visited: number;
  pruned: number;
  intervalCount: number;
  coveredPoints: string;
  intervals: IntervalInfo[];
}

export function validateRect(bits: number, r: Rect): Rect {
  const size = Number(gridSize(bits));
  const entries: Array<[string, number]> = [
    ["xmin", r.xmin],
    ["ymin", r.ymin],
    ["xmax", r.xmax],
    ["ymax", r.ymax],
  ];
  for (const [name, v] of entries) {
    if (typeof v !== "number" || !Number.isInteger(v) || v < 0) {
      throw new ApiError("E_RECT_COORD", name + " 必须是非负整数");
    }
    if (v > size) {
      throw new ApiError("E_RECT_OUT_OF_GRID", name + "=" + v + " 超出网格边长 " + size);
    }
  }
  if (r.xmax < r.xmin || r.ymax < r.ymin) {
    throw new ApiError("E_RECT_INVERTED", "矩形边界颠倒：要求 xmin<=xmax 且 ymin<=ymax（半开区间，相等为空矩形）");
  }
  return r;
}

export function coverRect(bits: number, rect: Rect, budget: Budget = {}): CoverResult {
  validateBits(bits);
  validateRect(bits, rect);
  const maxDepth = budget.maxDepth ?? bits;
  if (!Number.isInteger(maxDepth) || maxDepth < 0 || maxDepth > bits) {
    throw new ApiError("E_BUDGET", "maxDepth 必须在 0.." + bits + " 之间");
  }
  const maxVisited = budget.maxVisited ?? Number.MAX_SAFE_INTEGER;
  const maxIntervals = budget.maxIntervals ?? Number.MAX_SAFE_INTEGER;

  let visited = 0;
  let pruned = 0;
  let incompleteReason: string | undefined;
  const raw: IntervalInfo[] = [];

  const empty = rect.xmin === rect.xmax || rect.ymin === rect.ymax;

  function visit(level: number, prefix: bigint, bx: number, by: number, s: number): void {
    if (incompleteReason) return;
    visited++;
    if (visited > maxVisited) {
      incompleteReason = "访问节点数超过预算 maxVisited=" + maxVisited;
      return;
    }
    const inX = bx < rect.xmax && bx + s > rect.xmin;
    const inY = by < rect.ymax && by + s > rect.ymin;
    if (empty || !inX || !inY) {
      pruned++;
      return;
    }
    const fullyInside =
      bx >= rect.xmin && bx + s <= rect.xmax && by >= rect.ymin && by + s <= rect.ymax;
    if (fullyInside || s === 1) {
      if (raw.length >= maxIntervals) {
        incompleteReason = "输出区间数超过预算 maxIntervals=" + maxIntervals;
        return;
      }
      const shift = BigInt(2 * (bits - level));
      const start = prefix << shift;
      const count = BigInt(s) * BigInt(s);
      raw.push({
        start: start.toString(),
        end: (start + count - 1n).toString(),
        level,
        prefix: prefix.toString(2).padStart(2 * level, "0") || "(root)",
        blockX: bx,
        blockY: by,
        blockSize: s,
        reason: fullyInside
          ? "L" + level + " 子块 [" + bx + "," + (bx + s) + ")x[" + by + "," + (by + s) + ") 完全包含于查询矩形，输出连续键区间"
          : "L" + level + " 单点 (" + bx + "," + by + ") 在矩形内",
      });
      return;
    }
    if (level >= maxDepth) {
      incompleteReason = "达到最大深度 maxDepth=" + maxDepth + "，仍有部分相交子块未细分";
      return;
    }
    const half = s >> 1;
    const p2 = prefix << 2n;
    visit(level + 1, p2 | 0n, bx, by, half);
    visit(level + 1, p2 | 1n, bx + half, by, half);
    visit(level + 1, p2 | 2n, bx, by + half, half);
    visit(level + 1, p2 | 3n, bx + half, by + half, half);
  }

  visit(0, 0n, 0, 0, Number(gridSize(bits)));

  const merged: IntervalInfo[] = [];
  for (const iv of raw) {
    const last = merged[merged.length - 1];
    if (last && BigInt(last.end) + 1n === BigInt(iv.start)) {
      last.end = iv.end;
      last.reason += "；与后续 L" + iv.level + " 区间相邻，合并";
    } else {
      merged.push({ ...iv });
    }
  }

  let covered = 0n;
  for (const iv of merged) covered += BigInt(iv.end) - BigInt(iv.start) + 1n;

  return {
    status: incompleteReason ? "incomplete" : "complete",
    incompleteReason,
    visited,
    pruned,
    intervalCount: merged.length,
    coveredPoints: covered.toString(),
    intervals: merged,
  };
}

export function keyInIntervals(key: bigint, intervals: Array<{ start: string; end: string }>): boolean {
  for (const iv of intervals) {
    if (key >= BigInt(iv.start) && key <= BigInt(iv.end)) return true;
  }
  return false;
}
