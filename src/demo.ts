import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertKeyInRange,
  deinterleave,
  interleave,
  makeGrid,
} from "./morton.js";
import { cover } from "./cover.js";
import { bruteForceCheck, intervalPointCount } from "./verify.js";
import { getReport, listReports, openDb, saveReport } from "./db.js";

function h1(title: string): void {
  process.stdout.write(`\n=== ${title} ===\n`);
}

function ok(cond: boolean, label: string): void {
  process.stdout.write(`${cond ? "通过" : "失败"}  ${label}\n`);
  if (!cond) process.exitCode = 1;
}

const tmp = mkdtempSync(join(tmpdir(), "morton-demo-"));
openDb(join(tmp, "demo.db"));

// 1) b=2 编码核对
h1("1. b=2 网格编码核对");
const g2 = makeGrid(2);
const expected = new Map([
  ["0,0", "0"],
  ["1,0", "1"],
  ["0,1", "2"],
  ["1,1", "3"],
]);
let encOk = true;
for (const [xy, want] of expected) {
  const [x, y] = xy.split(",").map(BigInt);
  const got = interleave(x!, y!).toString();
  process.stdout.write(`(${x},${y}) -> ${got}（期望 ${want}）\n`);
  if (got !== want) encOk = false;
}
ok(encOk, "(0,0)=0 (1,0)=1 (0,1)=2 (1,1)=3");

// 2) 穿过四象限的细矩形
h1("2. b=2 细矩形 [0,4) x [1,2) 穿过四象限");
const thin = cover(g2, { xmin: 0n, xmax: 4n, ymin: 1n, ymax: 2n });
process.stdout.write(`状态=${thin.status} 区间数=${thin.stats.intervalsOut} 面积=${thin.area}\n`);
for (const iv of thin.intervals) {
  const block = iv.blocks.map(
    (b) => `深度${b.depth} 前缀${b.prefix} 子块(${b.ox},${b.oy}) 边长${b.side}`
  );
  process.stdout.write(`  [${iv.lo}, ${iv.hi}] 点数=${iv.points}  <- ${block.join("; ")}\n`);
}
process.stdout.write(
  "为什么多个区间：y=1 的格子落在每个 2x2 象限的“y 高位=1”部分，\n" +
    "Morton 键在四象限边界不连续，细条带横跨四个象限，故需多个不相交区间精确覆盖。\n"
);
ok(thin.stats.intervalsOut > 1, "细矩形产生多个区间");
ok(intervalPointCount(thin).toString() === thin.area, "区间展开点数 == 矩形面积");
saveReport(thin);

// 3) 小网格逐点枚举比较
h1("3. b=3 随机矩形逐点枚举比较");
const g3 = makeGrid(3);
const r3 = { xmin: 1n, xmax: 6n, ymin: 2n, ymax: 7n };
const c3 = cover(g3, r3);
const check = bruteForceCheck(g3, r3, c3.intervals);
process.stdout.write(JSON.stringify(check, null, 2) + "\n");
ok(check.exact, "无假阳性、无遗漏、无重叠");
ok(check.coveredPoints === check.rectPoints, "覆盖点数 == 矩形点数");

// 4) 大位数往返与高位不丢失
h1("4. b=24 大键往返");
const g24 = makeGrid(24);
const X = (1n << 24n) - 1n;
const Y = 0b101010101010101010101010n;
const key = interleave(X, Y);
const back = deinterleave(key, 24);
process.stdout.write(`maxKey=${g24.maxKey}\nkey=${key}\n解码 x=${back.x} y=${back.y}\n`);
ok(back.x === X && back.y === Y, "b=24 往返一致，高位不丢失");
ok(key <= g24.maxKey, "最大交织键不超过 maxKey");

// 5) 边界行为
h1("5. 边界与特例");
const point = cover(g3, { xmin: 5n, xmax: 6n, ymin: 3n, ymax: 4n });
ok(point.status === "complete" && point.intervals.length === 1 && point.intervals[0]!.lo === point.intervals[0]!.hi, "单点=单个闭区间");

const empty = cover(g3, { xmin: 3n, xmax: 3n, ymin: 0n, ymax: 8n });
ok(empty.status === "complete" && empty.intervals.length === 0 && empty.area === "0", "零宽空矩形：0 区间、面积 0");

const full = cover(g3, { xmin: 0n, xmax: 8n, ymin: 0n, ymax: 8n });
ok(
  full.intervals.length === 1 && full.intervals[0]!.lo === "0" && full.intervals[0]!.hi === g3.maxKey.toString(),
  "全网格：单一区间 [0,maxKey]"
);

const a = cover(g3, { xmin: 0n, xmax: 4n, ymin: 0n, ymax: 8n });
const bRect = cover(g3, { xmin: 4n, xmax: 8n, ymin: 0n, ymax: 8n });
const adjacent =
  a.intervals[a.intervals.length - 1]!.hi + " 与 " + bRect.intervals[0]!.lo;
process.stdout.write(`相邻条带边界区间端点：${adjacent}（半开边界可无缝拼接）\n`);
ok(intervalPointCount(full) === intervalPointCount(a) + intervalPointCount(bRect), "相邻矩形点数可精确拼接");

const exhaust = cover(g3, r3, { maxVisited: 3, maxIntervals: 100 });
ok(exhaust.status === "incomplete" && exhaust.intervals.length === 0, "预算耗尽：incomplete 且不返回部分区间");
process.stdout.write(`预算耗尽原因：${exhaust.reason}\n`);

// 6) 持久化与“重启读取”
h1("6. 持久化：重启后读取原报告");
const saved = saveReport(c3);
const reportsBefore = listReports().length;
// 模拟重启：重新打开同一数据库
openDb(join(tmp, "demo.db"));
const reloaded = getReport(saved.id);
const reportsAfter = listReports().length;
ok(reportsBefore === reportsAfter, `重启后报告数量一致（${reportsAfter}）`);
ok(!!reloaded && reloaded.bits === 3 && reloaded.intervals.length === c3.intervals.length, "重新打开数据库后读到原报告快照");
process.stdout.write(`报告 id=${saved.id} ruleVersion=${saved.ruleVersion} status=${saved.status}\n`);

h1("7. 非法输入被拒绝");
const rejects: Array<[string, () => void]> = [
  ["颠倒边界", () => cover(g3, { xmin: 6n, xmax: 1n, ymin: 0n, ymax: 2n })],
  ["超出网格", () => cover(g3, { xmin: 0n, xmax: 9n, ymin: 0n, ymax: 2n })],
  ["b 越界", () => makeGrid(25)],
  ["键越界", () => {
    assertKeyInRange(g3, g3.maxKey + 1n);
  }],
];
for (const [label, fn] of rejects) {
  let threw = false;
  try {
    fn();
  } catch {
    threw = true;
  }
  ok(threw, `拒绝：${label}`);
}

h1("区间数量随形状变化");
for (const r of [
  { xmin: 0n, xmax: 8n, ymin: 0n, ymax: 8n, name: "全网格" },
  { xmin: 1n, xmax: 7n, ymin: 1n, ymax: 7n, name: "内嵌方块" },
  { xmin: 0n, xmax: 8n, ymin: 3n, ymax: 4n, name: "整宽横条" },
  { xmin: 3n, xmax: 4n, ymin: 0n, ymax: 8n, name: "整高竖条" },
] as const) {
  const res = cover(g3, r);
  process.stdout.write(`${r.name.padEnd(6)} 面积=${res.area.padStart(2)} 区间数=${res.stats.intervalsOut}\n`);
}

process.stdout.write("\n演示完成。\n");
