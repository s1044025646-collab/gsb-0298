// 演示脚本：二位网格、象限细矩形、暴力核对、大位往返、边界场景、重启读取。
import { decode, encode, encodeWithSteps } from "./morton";
import { coverRect, keyInIntervals } from "./cover";
import { ReportStore } from "./db";

function show(title: string): void {
  console.log("\n=== " + title + " ===");
}

export async function runDemo(dbPath: string): Promise<void> {
  show("二位网格编码核对 (b=2)");
  const cases: Array<[number, number, number]> = [[0, 0, 0], [1, 0, 1], [0, 1, 2], [1, 1, 3]];
  for (const [x, y, expect] of cases) {
    const key = encode(x, y, 2);
    console.log("(" + x + "," + y + ") -> " + key + " 期望 " + expect + " " + (key === BigInt(expect) ? "OK" : "FAIL"));
  }

  show("逐位编码过程 (b=4, x=5, y=10)");
  const enc = encodeWithSteps(5, 10, 4);
  for (const s of enc.steps) {
    console.log("位 " + s.bitIndex + ": x位=" + s.xBit + "->键位" + s.keyBitLow + ", y位=" + s.yBit + "->键位" + s.keyBitHigh + ", 部分键=" + s.partialKey);
  }
  console.log("最终键 =", enc.key.toString(), " 解码 =", decode(enc.key, 4));

  show("穿过四象限的细矩形 (b=2, [1,3)x[0,4))");
  const thin = coverRect(2, { xmin: 1, ymin: 0, xmax: 3, ymax: 4 });
  console.log("状态:", thin.status, "区间数:", thin.intervalCount, "访问节点:", thin.visited);
  for (const iv of thin.intervals) {
    console.log("[" + iv.start + ", " + iv.end + "] 前缀=" + iv.prefix + " " + iv.reason);
  }
  console.log("说明: 竖条跨越 y 方向象限边界，Z 序在边界处跳变，因此产生多个区间。");

  show("小网格暴力逐点核对 (b=1..6, 随机矩形)");
  let checked = 0;
  let seed = 42;
  const rand = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (let bits = 1; bits <= 6; bits++) {
    const size = 1 << bits;
    for (let t = 0; t < 20; t++) {
      const xmin = Math.floor(rand() * size);
      const ymin = Math.floor(rand() * size);
      const rect = {
        xmin,
        ymin,
        xmax: xmin + Math.floor(rand() * (size - xmin + 1)),
        ymax: ymin + Math.floor(rand() * (size - ymin + 1)),
      };
      const res = coverRect(bits, rect);
      if (res.status !== "complete") throw new Error("应完整");
      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
          const inside = x >= rect.xmin && x < rect.xmax && y >= rect.ymin && y < rect.ymax;
          const inSet = keyInIntervals(encode(x, y, bits), res.intervals);
          if (inside !== inSet) throw new Error("不一致 b=" + bits + " (" + x + "," + y + ")");
          checked++;
        }
      }
      const area = BigInt(rect.xmax - rect.xmin) * BigInt(rect.ymax - rect.ymin);
      if (BigInt(res.coveredPoints) !== area) throw new Error("面积不符");
    }
  }
  console.log("逐点比较通过，共核对", checked, "个点");

  show("大位数往返与高位保留 (b=24)");
  const b24 = 1 << 24;
  const pts: Array<[number, number]> = [[0, 0], [b24 - 1, b24 - 1], [b24 - 1, 0], [0, b24 - 1], [12345678, 8765432]];
  for (const [x, y] of pts) {
    const key = encode(x, y, 24);
    const back = decode(key, 24);
    const ok = back.x === x && back.y === y;
    console.log("(" + x + "," + y + ") -> " + key + " -> (" + back.x + "," + back.y + ") " + (ok ? "OK" : "FAIL"));
  }

  show("边界场景");
  const single = coverRect(4, { xmin: 3, ymin: 5, xmax: 4, ymax: 6 });
  console.log("单点:", single.intervalCount, "个区间, 覆盖点数 =", single.coveredPoints);
  const empty = coverRect(4, { xmin: 2, ymin: 2, xmax: 2, ymax: 6 });
  console.log("零宽空矩形:", empty.status, "区间数 =", empty.intervalCount, "点数 =", empty.coveredPoints);
  const full = coverRect(4, { xmin: 0, ymin: 0, xmax: 16, ymax: 16 });
  console.log("全幅:", full.intervalCount, "个区间 [" + full.intervals[0].start + ", " + full.intervals[0].end + "]");
  const stripA = coverRect(4, { xmin: 0, ymin: 0, xmax: 8, ymax: 16 });
  const stripB = coverRect(4, { xmin: 8, ymin: 0, xmax: 16, ymax: 16 });
  console.log("相邻条带点数和 =", BigInt(stripA.coveredPoints) + BigInt(stripB.coveredPoints), "(应为 256)");
  const starved = coverRect(8, { xmin: 1, ymin: 1, xmax: 200, ymax: 200 }, { maxIntervals: 3 });
  console.log("预算耗尽:", starved.status, "-", starved.incompleteReason, "已访问", starved.visited, "节点");

  show("报告持久化与重启读取");
  const store = new ReportStore(dbPath);
  const id = store.saveReport(2, { xmin: 1, ymin: 0, xmax: 3, ymax: 4 }, thin);
  store.close();
  const store2 = new ReportStore(dbPath);
  const loaded = store2.getReport(id);
  store2.close();
  console.log("重新打开数据库读取报告 #" + id + ":", loaded?.status, "区间数 =", loaded?.intervalCount, "规则 =", loaded?.ruleVersion);

  show("区间数量随形状变化 (b=6, 面积均为 256)");
  const shapes: Array<[string, { xmin: number; ymin: number; xmax: number; ymax: number }]> = [
    ["对齐方块 16x16 @ (0,0)", { xmin: 0, ymin: 0, xmax: 16, ymax: 16 }],
    ["错位方块 16x16 @ (3,5)", { xmin: 3, ymin: 5, xmax: 19, ymax: 21 }],
    ["细横条 64x4", { xmin: 0, ymin: 6, xmax: 64, ymax: 10 }],
    ["细竖条 4x64", { xmin: 9, ymin: 0, xmax: 13, ymax: 64 }],
  ];
  for (const [name, rect] of shapes) {
    const r = coverRect(6, rect);
    console.log(name + ": " + r.intervalCount + " 个区间");
  }
}
