import {
  Grid,
  MAX_BITS,
  ValidationError,
} from "./morton.js";

export interface RectInput {
  xmin: bigint;
  xmax: bigint;
  ymin: bigint;
  ymax: bigint;
}

export interface Budgets {
  /** 最多访问的四叉节点数 */
  maxVisited: number;
  /** 最多输出区间数（合并前的满块数） */
  maxIntervals: number;
}

export const DEFAULT_BUDGETS: Budgets = {
  maxVisited: 2_000_000,
  maxIntervals: 500_000,
};

export interface RawSegment {
  lo: bigint;
  hi: bigint;
}

export interface BlockOrigin {
  /** 前缀所在层级（0=整网格，b=单格） */
  depth: number;
  /** Morton 前缀（键的高 2*depth 位） */
  prefix: string;
  /** 子块左下角（整数网格坐标） */
  ox: string;
  oy: string;
  /** 子块边长（格点数） */
  side: string;
}

export interface CoverInterval {
  lo: string;
  hi: string;
  /** 该区间覆盖的格点数 */
  points: string;
  /** 合并成该区间的子块来源（按键序） */
  blocks: BlockOrigin[];
}

export type CoverStatus = "complete" | "incomplete";

export interface CoverResult {
  bits: number;
  rect: { xmin: string; xmax: string; ymin: string; ymax: string };
  area: string;
  status: CoverStatus;
  intervals: CoverInterval[];
  stats: {
    visited: number;
    emittedBlocks: number;
    intervalsOut: number;
    pointsCovered: string;
    maxDepth: number;
    skipped: number;
    fullyContained: number;
  };
  budgets: Budgets;
  reason?: string;
}

export function validateRect(grid: Grid, r: RectInput): void {
  for (const [name, v] of [
    ["xmin", r.xmin],
    ["xmax", r.xmax],
    ["ymin", r.ymin],
    ["ymax", r.ymax],
  ] as const) {
    if (typeof v !== "bigint" || v < 0n) {
      throw new ValidationError("INVALID_INTEGER", `${name} 必须是非负整数`);
    }
    if (v > grid.size) {
      throw new ValidationError(
        "RECT_OUT_OF_GRID",
        `${name}=${v.toString()} 超出网格上界 ${grid.size.toString()}（b=${grid.bits}）`
      );
    }
  }
  if (r.xmin > r.xmax) {
    throw new ValidationError("RECT_INVERTED", `xmin(${r.xmin}) > xmax(${r.xmax})，不允许颠倒边界`);
  }
  if (r.ymin > r.ymax) {
    throw new ValidationError("RECT_INVERTED", `ymin(${r.ymin}) > ymax(${r.ymax})，不允许颠倒边界`);
  }
}

interface Emitted extends RawSegment {
  block: BlockOrigin;
}

export function cover(grid: Grid, rect: RectInput, budgetsIn: Partial<Budgets> = {}): CoverResult {
  validateRect(grid, rect);
  const budgets: Budgets = { ...DEFAULT_BUDGETS, ...budgetsIn };
  if (
    !Number.isInteger(budgets.maxVisited) ||
    !Number.isInteger(budgets.maxIntervals) ||
    budgets.maxVisited <= 0 ||
    budgets.maxIntervals <= 0
  ) {
    throw new ValidationError("INVALID_BUDGET", "maxVisited / maxIntervals 必须是正整数");
  }

  const emitted: Emitted[] = [];
  let visited = 0;
  let skipped = 0;
  let fullyContained = 0;
  let maxDepth = 0;
  let stopReason: string | undefined;

  const b = grid.bits;

  function visit(depth: number, ox: bigint, oy: bigint, side: bigint, prefix: bigint): void {
    if (stopReason) return;
    visited++;
    if (visited > budgets.maxVisited) {
      stopReason = `访问节点数超过预算 maxVisited=${budgets.maxVisited}`;
      return;
    }
    if (depth > maxDepth) maxDepth = depth;

    const endX = ox + side;
    const endY = oy + side;

    // 完全在半开矩形外
    if (
      endX <= rect.xmin ||
      ox >= rect.xmax ||
      endY <= rect.ymin ||
      oy >= rect.ymax
    ) {
      skipped++;
      return;
    }

    // 完全被包含
    if (
      rect.xmin <= ox &&
      endX <= rect.xmax &&
      rect.ymin <= oy &&
      endY <= rect.ymax
    ) {
      if (emitted.length >= budgets.maxIntervals) {
        stopReason = `输出区间数超过预算 maxIntervals=${budgets.maxIntervals}`;
        return;
      }
      const suffixBits = 2 * (b - depth);
      const lo = prefix << BigInt(suffixBits);
      const hi = ((prefix + 1n) << BigInt(suffixBits)) - 1n;
      emitted.push({
        lo,
        hi,
        block: {
          depth,
          prefix: prefix.toString(),
          ox: ox.toString(),
          oy: oy.toString(),
          side: side.toString(),
        },
      });
      fullyContained++;
      return;
    }

    // 叶子（单格）：整数对齐块与半开矩形相交即被包含，不会走到这里
    if (depth === b) {
      if (emitted.length >= budgets.maxIntervals) {
        stopReason = `输出区间数超过预算 maxIntervals=${budgets.maxIntervals}`;
        return;
      }
      const lo = prefix;
      emitted.push({
        lo,
        hi: lo,
        block: { depth, prefix: prefix.toString(), ox: ox.toString(), oy: oy.toString(), side: "1" },
      });
      fullyContained++;
      return;
    }

    // 部分相交 -> 细分为四个子块，按 Morton 子序 00,01,10,11
    const childSide = side >> 1n;
    for (let q = 0; q < 4; q++) {
      const xbit = q & 1;
      const ybit = (q >> 1) & 1;
      const cx = ox + (xbit ? childSide : 0n);
      const cy = oy + (ybit ? childSide : 0n);
      const childPrefix = (prefix << 2n) | BigInt(q);
      visit(depth + 1, cx, cy, childSide, childPrefix);
      if (stopReason) return;
    }
  }

  visit(0, 0n, 0n, grid.size, 0n);

  const area =
    (rect.xmax - rect.xmin) * (rect.ymax - rect.ymin);

  if (stopReason) {
    // 预算耗尽：明确未完成，绝不把部分结果伪装成完整覆盖
    return {
      bits: b,
      rect: bigRect(rect),
      area: area.toString(),
      status: "incomplete",
      intervals: [],
      stats: {
        visited,
        emittedBlocks: emitted.length,
        intervalsOut: 0,
        pointsCovered: "0",
        maxDepth,
        skipped,
        fullyContained,
      },
      budgets,
      reason: stopReason,
    };
  }

  // emitted 已按 Morton 前缀深度优先、子序 0..3 生成，天然按 lo 递增。
  emitted.sort((a, c) => (a.lo < c.lo ? -1 : a.lo > c.lo ? 1 : 0));

  const intervals: CoverInterval[] = [];
  let pointsCovered = 0n;
  for (const seg of emitted) {
    pointsCovered += seg.hi - seg.lo + 1n;
    const last = intervals[intervals.length - 1];
    if (last && BigInt(last.hi) + 1n === seg.lo) {
      last.hi = seg.hi.toString();
      last.blocks.push(seg.block);
    } else {
      intervals.push({
        lo: seg.lo.toString(),
        hi: seg.hi.toString(),
        points: (seg.hi - seg.lo + 1n).toString(),
        blocks: [seg.block],
      });
    }
  }
  // 修正合并后区间的点数
  for (const iv of intervals) {
    iv.points = (BigInt(iv.hi) - BigInt(iv.lo) + 1n).toString();
  }

  return {
    bits: b,
    rect: bigRect(rect),
    area: area.toString(),
    status: "complete",
    intervals,
    stats: {
      visited,
      emittedBlocks: emitted.length,
      intervalsOut: intervals.length,
      pointsCovered: pointsCovered.toString(),
      maxDepth,
      skipped,
      fullyContained,
    },
    budgets,
  };
}

function bigRect(r: RectInput) {
  return {
    xmin: r.xmin.toString(),
    xmax: r.xmax.toString(),
    ymin: r.ymin.toString(),
    ymax: r.ymax.toString(),
  };
}

export { MAX_BITS };
