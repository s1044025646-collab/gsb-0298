import test from "node:test";
import assert from "node:assert/strict";
import { cover, validateRect } from "../src/cover.js";
import { makeGrid } from "../src/morton.js";
import { bruteForceCheck, intervalPointCount } from "../src/verify.js";

test("单点 / 空 / 全网格", () => {
  const g = makeGrid(3);
  const point = cover(g, { xmin: 5n, xmax: 6n, ymin: 3n, ymax: 4n });
  assert.equal(point.status, "complete");
  assert.equal(point.intervals.length, 1);
  assert.equal(point.intervals[0]!.lo, point.intervals[0]!.hi);

  const empty = cover(g, { xmin: 3n, xmax: 3n, ymin: 0n, ymax: 8n });
  assert.deepEqual(empty.intervals, []);
  assert.equal(empty.area, "0");

  const full = cover(g, { xmin: 0n, xmax: 8n, ymin: 0n, ymax: 8n });
  assert.equal(full.intervals.length, 1);
  assert.equal(full.intervals[0]!.lo, "0");
  assert.equal(full.intervals[0]!.hi, g.maxKey.toString());
});

test("区间展开点数 == 面积，且逐点枚举精确", () => {
  const g = makeGrid(4);
  const rects = [
    { xmin: 0n, xmax: 16n, ymin: 1n, ymax: 2n },
    { xmin: 1n, xmax: 15n, ymin: 1n, ymax: 15n },
    { xmin: 3n, xmax: 13n, ymin: 7n, ymax: 9n },
    { xmin: 8n, xmax: 16n, ymin: 0n, ymax: 16n },
  ];
  for (const r of rects) {
    const c = cover(g, r);
    assert.equal(c.status, "complete");
    const area = (r.xmax - r.xmin) * (r.ymax - r.ymin);
    assert.equal(intervalPointCount(c), area);
    const rep = bruteForceCheck(g, r, c.intervals);
    assert.equal(rep.falsePositive, "0");
    assert.equal(rep.falseNegative, "0");
    assert.equal(rep.duplicatePoints, "0");
    assert.equal(rep.coveredPoints, area.toString());
  }
});

test("区间按起点递增且不重叠", () => {
  const g = makeGrid(5);
  const c = cover(g, { xmin: 2n, xmax: 30n, ymin: 1n, ymax: 31n });
  for (let i = 1; i < c.intervals.length; i++) {
    const prev = c.intervals[i - 1]!;
    const cur = c.intervals[i]!;
    assert.ok(BigInt(cur.lo) > BigInt(prev.hi));
  }
});

test("相邻矩形可拼接成全网格", () => {
  const g = makeGrid(4);
  const left = cover(g, { xmin: 0n, xmax: 8n, ymin: 0n, ymax: 16n });
  const right = cover(g, { xmin: 8n, xmax: 16n, ymin: 0n, ymax: 16n });
  const full = cover(g, { xmin: 0n, xmax: 16n, ymin: 0n, ymax: 16n });
  assert.equal(intervalPointCount(left) + intervalPointCount(right), intervalPointCount(full));
});

test("细条带横跨四象限产生多个区间", () => {
  const g = makeGrid(2);
  const c = cover(g, { xmin: 0n, xmax: 4n, ymin: 1n, ymax: 2n });
  assert.ok(c.intervals.length > 1);
  assert.equal(intervalPointCount(c), 4n);
});

test("预算耗尽返回 incomplete 且无部分区间", () => {
  const g = makeGrid(6);
  const r = { xmin: 1n, xmax: 60n, ymin: 1n, ymax: 60n };
  const c = cover(g, r, { maxVisited: 5, maxIntervals: 100 });
  assert.equal(c.status, "incomplete");
  assert.deepEqual(c.intervals, []);
  assert.ok(c.reason);
  const c2 = cover(g, r, { maxVisited: 10_000_000, maxIntervals: 2 });
  assert.equal(c2.status, "incomplete");
});

test("拒绝颠倒 / 越界矩形", () => {
  const g = makeGrid(3);
  assert.throws(
    () => validateRect(g, { xmin: 6n, xmax: 1n, ymin: 0n, ymax: 2n }),
    (e: unknown) => (e as { code?: string }).code === "RECT_INVERTED"
  );
  assert.throws(
    () => cover(g, { xmin: 0n, xmax: 9n, ymin: 0n, ymax: 2n }),
    (e: unknown) => (e as { code?: string }).code === "RECT_OUT_OF_GRID"
  );
});
