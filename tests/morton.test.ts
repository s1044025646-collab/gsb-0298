import test from "node:test";
import assert from "node:assert/strict";
import {
  assertKeyInRange,
  deinterleave,
  interleave,
  makeGrid,
  parseNonNegBigInt,
  ValidationError,
} from "../src/morton.js";

test("b=2 交织核对", () => {
  assert.equal(interleave(0n, 0n), 0n);
  assert.equal(interleave(1n, 0n), 1n);
  assert.equal(interleave(0n, 1n), 2n);
  assert.equal(interleave(1n, 1n), 3n);
  assert.equal(interleave(2n, 1n), 6n); // x=10,y=01 -> 0110
});

test("b=24 往返与高位", () => {
  const g = makeGrid(24);
  for (const [x, y] of [
    [g.maxCoord, g.maxCoord],
    [g.maxCoord, 0n],
    [0n, g.maxCoord],
    [0xabcdefn, 0x123456n],
  ] as const) {
    const k = interleave(x, y);
    assert.ok(k <= g.maxKey);
    const back = deinterleave(k, 24);
    assert.equal(back.x, x);
    assert.equal(back.y, y);
  }
  assert.equal(interleave(g.maxCoord, g.maxCoord), g.maxKey);
});

test("键范围与字符串语法", () => {
  const g = makeGrid(3);
  assert.throws(() => makeGrid(0), ValidationError);
  assert.throws(() => makeGrid(25), ValidationError);
  assert.throws(() => assertKeyInRange(g, g.maxKey + 1n), ValidationError);
  assert.throws(() => parseNonNegBigInt("-1", "k"), ValidationError);
  assert.throws(() => parseNonNegBigInt("1.5", "k"), ValidationError);
  assert.throws(() => parseNonNegBigInt("01", "k"), ValidationError);
  assert.throws(() => parseNonNegBigInt(" 1", "k"), ValidationError);
  assert.equal(parseNonNegBigInt("0", "k"), 0n);
});

test("b=1 只有 2x2", () => {
  const g = makeGrid(1);
  assert.equal(g.size, 2n);
  assert.equal(g.maxKey, 3n);
  assert.deepEqual(deinterleave(2n, 1), { x: 0n, y: 1n });
});
