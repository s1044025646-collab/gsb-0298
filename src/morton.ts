// Morton (Z-order) 编码核心：位交织 / 反交织，全部使用 BigInt。
// 规则版本：x 的第 i 位 -> 键的第 2i 位；y 的第 i 位 -> 键的第 2i+1 位。
export const RULE_VERSION = "morton-xy-interleave-v1";

export const MIN_BITS = 1;
export const MAX_BITS = 24;

export class ApiError extends Error {
  constructor(public code: string, message: string) {
    super(message);
    this.name = "ApiError";
  }
}

export function validateBits(bits: unknown): number {
  if (typeof bits !== "number" || !Number.isInteger(bits)) {
    throw new ApiError("E_BITS_TYPE", "bits 必须是整数");
  }
  if (bits < MIN_BITS || bits > MAX_BITS) {
    throw new ApiError("E_BITS_RANGE", `bits 必须在 ${MIN_BITS}..${MAX_BITS} 之间`);
  }
  return bits;
}

export function gridSize(bits: number): bigint {
  return 1n << BigInt(bits);
}

export function maxKey(bits: number): bigint {
  return (1n << BigInt(2 * bits)) - 1n;
}

export function validateCoord(v: unknown, name: string, bits: number): number {
  if (typeof v !== "number" || !Number.isInteger(v) || v < 0) {
    throw new ApiError("E_COORD", `${name} 必须是非负整数`);
  }
  if (BigInt(v) >= gridSize(bits)) {
    throw new ApiError("E_COORD_RANGE", `${name}=${v} 超出 ${bits} 位网格范围`);
  }
  return v;
}

export function parseKey(raw: unknown, bits: number): bigint {
  if (typeof raw !== "string" || !/^(0|[1-9][0-9]*)$/.test(raw)) {
    throw new ApiError("E_KEY_SYNTAX", "键必须是非负整数的十进制字符串");
  }
  const key = BigInt(raw);
  if (key > maxKey(bits)) {
    throw new ApiError("E_KEY_RANGE", `键 ${raw} 超出 ${bits} 位网格最大键 ${maxKey(bits)}`);
  }
  return key;
}

export interface EncodeStep {
  bitIndex: number;
  xBit: number;
  yBit: number;
  keyBitLow: number; // 2i
  keyBitHigh: number; // 2i+1
  partialKey: string;
}

export function encodeWithSteps(x: number, y: number, bits: number): { key: bigint; steps: EncodeStep[] } {
  let key = 0n;
  const steps: EncodeStep[] = [];
  for (let i = 0; i < bits; i++) {
    const xb = (x >> i) & 1;
    const yb = (y >> i) & 1;
    if (xb) key |= 1n << BigInt(2 * i);
    if (yb) key |= 1n << BigInt(2 * i + 1);
    steps.push({ bitIndex: i, xBit: xb, yBit: yb, keyBitLow: 2 * i, keyBitHigh: 2 * i + 1, partialKey: key.toString() });
  }
  return { key, steps };
}

export function encode(x: number, y: number, bits: number): bigint {
  return encodeWithSteps(x, y, bits).key;
}

export function decode(key: bigint, bits: number): { x: number; y: number } {
  let x = 0;
  let y = 0;
  for (let i = 0; i < bits; i++) {
    if ((key >> BigInt(2 * i)) & 1n) x |= 1 << i;
    if ((key >> BigInt(2 * i + 1)) & 1n) y |= 1 << i;
  }
  return { x, y };
}
