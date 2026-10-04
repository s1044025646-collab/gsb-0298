// 测试：编码/解码、覆盖正确性（暴力对照）、边界、预算、非法输入、持久化、API。
import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ApiError, decode, encode, encodeWithSteps, maxKey, parseKey } from "../src/morton";
import { coverRect, keyInIntervals } from "../src/cover";
import { ReportStore } from "../src/db";
import { startServer } from "../src/server";

let passed = 0;
async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  await fn();
  passed++;
  console.log("PASS " + name);
}

async function main(): Promise<void> {
  await test("b=2 四象限编码", () => {
    assert.equal(encode(0, 0, 2), 0n);
    assert.equal(encode(1, 0, 2), 1n);
    assert.equal(encode(0, 1, 2), 2n);
    assert.equal(encode(1, 1, 2), 3n);
    assert.equal(encode(3, 3, 2), 15n);
    assert.equal(encode(2, 0, 2), 4n);
    assert.equal(encode(0, 2, 2), 8n);
  });

  await test("往返一致性（b=1..8 全枚举 + b=24 抽样）", () => {
    for (let bits = 1; bits <= 8; bits++) {
      const size = 1 << bits;
      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
          const p = decode(encode(x, y, bits), bits);
          assert.ok(p.x === x && p.y === y, "b=" + bits + " (" + x + "," + y + ")");
        }
      }
    }
    const m = (1 << 24) - 1;
    const pts: Array<[number, number]> = [[0, 0], [m, m], [m, 0], [0, m], [12345678, 8765432], [1, m - 1]];
    for (const [x, y] of pts) {
      const p = decode(encode(x, y, 24), 24);
      assert.ok(p.x === x && p.y === y);
    }
  });

  await test("高位不丢失（BigInt）", () => {
    const key = encode((1 << 24) - 1, (1 << 24) - 1, 24);
    assert.equal(key, (1n << 48n) - 1n);
    assert.equal(key.toString(), "281474976710655");
    assert.ok(key > 0xFFFFFFFFn, "超出 32 位位运算范围");
  });

  await test("逐位编码步骤", () => {
    const r = encodeWithSteps(5, 10, 4);
    assert.equal(r.steps.length, 4);
    assert.equal(r.key, encode(5, 10, 4));
    assert.equal(r.steps[0].keyBitLow, 0);
    assert.equal(r.steps[0].keyBitHigh, 1);
  });

  await test("覆盖与暴力逐点一致 (b=1..6 随机矩形)", () => {
    let seed = 7;
    const rand = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    for (let bits = 1; bits <= 6; bits++) {
      const size = 1 << bits;
      for (let t = 0; t < 30; t++) {
        const xmin = Math.floor(rand() * size);
        const ymin = Math.floor(rand() * size);
        const rect = {
          xmin, ymin,
          xmax: xmin + Math.floor(rand() * (size - xmin + 1)),
          ymax: ymin + Math.floor(rand() * (size - ymin + 1)),
        };
        const res = coverRect(bits, rect);
        assert.equal(res.status, "complete");
        const area = BigInt(rect.xmax - rect.xmin) * BigInt(rect.ymax - rect.ymin);
        assert.equal(BigInt(res.coveredPoints), area, "面积");
        for (let i = 1; i < res.intervals.length; i++) {
          assert.ok(BigInt(res.intervals[i].start) > BigInt(res.intervals[i - 1].end), "递增不重叠");
        }
        for (let y = 0; y < size; y++) {
          for (let x = 0; x < size; x++) {
            const inside = x >= rect.xmin && x < rect.xmax && y >= rect.ymin && y < rect.ymax;
            assert.equal(keyInIntervals(encode(x, y, bits), res.intervals), inside, "b=" + bits + " (" + x + "," + y + ")");
          }
        }
      }
    }
  });

  await test("单点 / 空 / 全幅 / 相邻拼接", () => {
    const single = coverRect(4, { xmin: 3, ymin: 5, xmax: 4, ymax: 6 });
    assert.equal(single.intervalCount, 1);
    assert.equal(single.coveredPoints, "1");
    assert.equal(single.intervals[0].start, encode(3, 5, 4).toString());

    const empty = coverRect(4, { xmin: 2, ymin: 2, xmax: 2, ymax: 6 });
    assert.equal(empty.status, "complete");
    assert.equal(empty.intervalCount, 0);
    assert.equal(empty.coveredPoints, "0");

    const full = coverRect(4, { xmin: 0, ymin: 0, xmax: 16, ymax: 16 });
    assert.equal(full.intervalCount, 1);
    assert.equal(full.intervals[0].start, "0");
    assert.equal(full.intervals[0].end, "255");

    const a = coverRect(4, { xmin: 0, ymin: 0, xmax: 8, ymax: 16 });
    const b = coverRect(4, { xmin: 8, ymin: 0, xmax: 16, ymax: 16 });
    assert.equal(BigInt(a.coveredPoints) + BigInt(b.coveredPoints), 256n);
    for (const iv of b.intervals) {
      for (let k = BigInt(iv.start); k <= BigInt(iv.end); k++) {
        assert.ok(!keyInIntervals(k, a.intervals));
      }
    }
  });

  await test("沿分区边界的条带", () => {
    const strip = coverRect(4, { xmin: 7, ymin: 0, xmax: 9, ymax: 16 });
    assert.equal(strip.status, "complete");
    assert.equal(strip.coveredPoints, "32");
    for (let y = 0; y < 16; y++) {
      for (const x of [7, 8]) {
        assert.ok(keyInIntervals(encode(x, y, 4), strip.intervals));
      }
      assert.ok(!keyInIntervals(encode(6, y, 4), strip.intervals));
      assert.ok(!keyInIntervals(encode(9, y, 4), strip.intervals));
    }
  });

  await test("预算耗尽返回 incomplete", () => {
    const r1 = coverRect(8, { xmin: 1, ymin: 1, xmax: 200, ymax: 200 }, { maxIntervals: 3 });
    assert.equal(r1.status, "incomplete");
    assert.ok(r1.incompleteReason);
    const r2 = coverRect(8, { xmin: 1, ymin: 1, xmax: 200, ymax: 200 }, { maxVisited: 5 });
    assert.equal(r2.status, "incomplete");
    const r3 = coverRect(8, { xmin: 1, ymin: 1, xmax: 200, ymax: 200 }, { maxDepth: 2 });
    assert.equal(r3.status, "incomplete");
  });

  await test("非法输入错误码", () => {
    assert.throws(() => coverRect(0, { xmin: 0, ymin: 0, xmax: 1, ymax: 1 }), (e: any) => e.code === "E_BITS_RANGE");
    assert.throws(() => coverRect(25, { xmin: 0, ymin: 0, xmax: 1, ymax: 1 }), (e: any) => e.code === "E_BITS_RANGE");
    assert.throws(() => coverRect(4, { xmin: 5, ymin: 0, xmax: 3, ymax: 1 }), (e: any) => e.code === "E_RECT_INVERTED");
    assert.throws(() => coverRect(4, { xmin: 0, ymin: 0, xmax: 17, ymax: 1 }), (e: any) => e.code === "E_RECT_OUT_OF_GRID");
    assert.throws(() => coverRect(4, { xmin: -1, ymin: 0, xmax: 1, ymax: 1 }), (e: any) => e.code === "E_RECT_COORD");
    assert.throws(() => parseKey("abc", 4), (e: any) => e.code === "E_KEY_SYNTAX");
    assert.throws(() => parseKey("-3", 4), (e: any) => e.code === "E_KEY_SYNTAX");
    assert.throws(() => parseKey("256", 4), (e: any) => e.code === "E_KEY_RANGE");
    assert.equal(parseKey(maxKey(4).toString(), 4), 255n);
  });

  await test("持久化：重启读取原报告", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "morton-"));
    const dbPath = path.join(dir, "t.db");
    const rect = { xmin: 1, ymin: 1, xmax: 7, ymax: 7 };
    const res = coverRect(3, rect);
    const s1 = new ReportStore(dbPath);
    const id = s1.saveReport(3, rect, res);
    s1.close();
    const s2 = new ReportStore(dbPath);
    const loaded = s2.getReport(id);
    s2.close();
    assert.ok(loaded);
    assert.equal(loaded!.bits, 3);
    assert.equal(loaded!.status, "complete");
    assert.deepEqual(loaded!.intervals, JSON.parse(JSON.stringify(res.intervals)));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  await test("HTTP API 端到端", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "morton-api-"));
    const started = await startServer({ port: 0, dbPath: path.join(dir, "api.db") });
    const base = "http://127.0.0.1:" + started.port;
    const post = async (p: string, body: unknown) => {
      const r = await fetch(base + p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      return { status: r.status, body: (await r.json()) as any };
    };

    const enc = await post("/encode", { bits: 2, x: 1, y: 1 });
    assert.equal(enc.body.key, "3");
    assert.equal(enc.body.steps.length, 2);

    const dec = await post("/decode", { bits: 2, key: "3" });
    assert.deepEqual([dec.body.x, dec.body.y], [1, 1]);

    const cov = await post("/cover", { bits: 2, rect: { xmin: 1, ymin: 0, xmax: 3, ymax: 4 } });
    assert.equal(cov.body.status, "complete");
    assert.ok(cov.body.reportId > 0);

    const member = await post("/contains", { reportId: cov.body.reportId, key: "9" });
    assert.equal(member.body.contained, true);
    const nonMember = await post("/contains", { reportId: cov.body.reportId, key: "0" });
    assert.equal(nonMember.body.contained, false);

    const bad = await post("/encode", { bits: 99, x: 0, y: 0 });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.error.code, "E_BITS_RANGE");

    const list = (await (await fetch(base + "/reports")).json()) as any;
    assert.ok(list.reports.length >= 1);
    const one = (await (await fetch(base + "/reports/" + cov.body.reportId)).json()) as any;
    assert.equal(one.bits, 2);
    const exp = await fetch(base + "/reports/" + cov.body.reportId + "/export");
    assert.equal(exp.status, 200);

    (started.server as any).closeAllConnections?.();
    started.server.close();
    started.store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  console.log("\n全部测试通过: " + passed + " 项");
}

main().catch((e) => {
  console.error("FAIL:", e);
  process.exit(1);
});
