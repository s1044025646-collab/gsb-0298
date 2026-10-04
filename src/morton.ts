/**
 * Morton（Z-order）位交织与反交织，全部使用 BigInt，
 * 不依赖 JavaScript 的 32 位位运算来保存大键。
 *
 * 约定：x 的第 i 位 -> 键第 2i 位；y 的第 i 位 -> 键第 2i+1 位。
 */

export const MIN_BITS = 1;
export const MAX_BITS = 24;

export interface Grid {
  /** 每维位数 b，网格边长为 2^b */
  bits: number;
  /** 边长 2^b */
  size: bigint;
  /** 最大合法键 2^(2b)-1 */
  maxKey: bigint;
  /** 最大合法坐标 2^b-1 */
  maxCoord: bigint;
}

export function makeGrid(bits: number): Grid {
  if (!Number.isInteger(bits) || bits < MIN_BITS || bits > MAX_BITS) {
    throw new ValidationError(
      "BITS_OUT_OF_RANGE",
      `网格位数 b 必须是 [${MIN_BITS}, ${MAX_BITS}] 内的整数，收到 ${String(bits)}`
    );
  }
  const size = 1n << BigInt(bits);
  return {
    bits,
    size,
    maxCoord: size - 1n,
    maxKey: (1n << (2n * BigInt(bits))) - 1n,
  };
}

export class ValidationError extends Error {
  code: string;
  details?: unknown;
  constructor(code: string, message: string, details?: unknown) {
    super(message);
    this.name = "ValidationError";
    this.code = code;
    this.details = details;
  }
}

/** 解析非负整数十进制字符串为 BigInt（拒绝非数字、前导符号、空白、前导 0 之外的怪字符） */
export function parseNonNegBigInt(raw: string, what: string): bigint {
  if (typeof raw !== "string" || !/^(0|[1-9][0-9]*)$/.test(raw)) {
    throw new ValidationError(
      "INVALID_INTEGER",
      `${what} 必须是非负整数十进制字符串，收到 ${JSON.stringify(raw)}`
    );
  }
  return BigInt(raw);
}

export function assertCoord(grid: Grid, value: bigint, axis: "x" | "y"): void {
  if (value < 0n || value > grid.maxCoord) {
    throw new ValidationError(
      "COORD_OUT_OF_RANGE",
      `坐标 ${axis}=${value.toString()} 超出网格范围 [0, ${grid.maxCoord.toString()}]（b=${grid.bits}）`
    );
  }
}

/** 交织：把 x、y 的各位展开到偶数、奇数位 */
export function interleave(x: bigint, y: bigint): bigint {
  let key = 0n;
  let i = 0;
  while ((x >> BigInt(i)) !== 0n || (y >> BigInt(i)) !== 0n) {
    const xi = (x >> BigInt(i)) & 1n;
    const yi = (y >> BigInt(i)) & 1n;
    key |= xi << (2n * BigInt(i));
    key |= yi << (2n * BigInt(i) + 1n);
    i++;
  }
  return key;
}

/** 反交织：从键还原 x、y，只取前 2*bits 位 */
export function deinterleave(key: bigint, bits: number): { x: bigint; y: bigint } {
  let x = 0n;
  let y = 0n;
  for (let i = 0; i < bits; i++) {
    const bi = BigInt(i);
    x |= ((key >> (2n * bi)) & 1n) << bi;
    y |= ((key >> (2n * bi + 1n)) & 1n) << bi;
  }
  return { x, y };
}

export interface EncodeStep {
  i: number;
  xbit: 0 | 1;
  ybit: 0 | 1;
  xAt: number;
  yAt: number;
  added: string;
  running: string;
}

/** 逐位编码过程说明 */
export function encodeSteps(grid: Grid, x: bigint, y: bigint): EncodeStep[] {
  const steps: EncodeStep[] = [];
  let running = 0n;
  for (let i = 0; i < grid.bits; i++) {
    const bi = BigInt(i);
    const xbit = Number((x >> bi) & 1n) as 0 | 1;
    const ybit = Number((y >> bi) & 1n) as 0 | 1;
    const xAt = 2 * i;
    const yAt = 2 * i + 1;
    let added = 0n;
    added |= BigInt(xbit) << BigInt(xAt);
    added |= BigInt(ybit) << BigInt(yAt);
    running |= added;
    steps.push({ i, xbit, ybit, xAt, yAt, added: added.toString(), running: running.toString() });
  }
  return steps;
}

export function assertKeyInRange(grid: Grid, key: bigint): void {
  if (key < 0n || key > grid.maxKey) {
    throw new ValidationError(
      "KEY_OUT_OF_RANGE",
      `键 ${key.toString()} 超出范围 [0, ${grid.maxKey.toString()}]（b=${grid.bits}）`
    );
  }
}

/** 给定键 k，判断它是否落在闭区间 [lo, hi] 内（成员核对的底层原语） */
export function keyInIntervals(key: bigint, intervals: ReadonlyArray<{ lo: bigint; hi: bigint }>): boolean {
  let lo = 0;
  let hi = intervals.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const seg = intervals[mid]!;
    if (key < seg.lo) hi = mid - 1;
    else if (key > seg.hi) lo = mid + 1;
    else return true;
  }
  return false;
}
