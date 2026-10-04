import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  assertCoord,
  assertKeyInRange,
  deinterleave,
  encodeSteps,
  interleave,
  makeGrid,
  parseNonNegBigInt,
} from "./morton.js";
import { cover } from "./cover.js";
import { isCoveredKey } from "./verify.js";
import { closeDb, diffReports, getReport, listReports, openDb, saveReport } from "./db.js";

const DATA_DIR = process.env.MORTON_DATA_DIR ?? join(process.cwd(), "data");

function print(obj: unknown): void {
  process.stdout.write(JSON.stringify(obj, null, 2) + "\n");
}

function fail(message: string, code = 1): never {
  process.stderr.write(`错误：${message}\n`);
  process.exit(code);
}

function argsToMap(argv: string[]): Map<string, string> {
  const map = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        map.set(key, next);
        i++;
      } else {
        map.set(key, "true");
      }
    }
  }
  return map;
}

function need(map: Map<string, string>, key: string): string {
  const v = map.get(key);
  if (v === undefined) fail(`缺少参数 --${key}`);
  return v!;
}

function parseRect(map: Map<string, string>, bits: number) {
  const grid = makeGrid(bits);
  const rect = {
    xmin: parseNonNegBigInt(need(map, "xmin"), "xmin"),
    xmax: parseNonNegBigInt(need(map, "xmax"), "xmax"),
    ymin: parseNonNegBigInt(need(map, "ymin"), "ymin"),
    ymax: parseNonNegBigInt(need(map, "ymax"), "ymax"),
  };
  return { grid, rect };
}

const HELP = `Morton 网格编码与矩形区间覆盖 CLI

用法：
  npm run cli -- encode  --bits 2 --x 1 --y 0
  npm run cli -- decode  --bits 2 --key 3
  npm run cli -- steps   --bits 3 --x 5 --y 2
  npm run cli -- cover   --bits 4 --xmin 1 --xmax 6 --ymin 0 --ymax 3 [--maxVisited N] [--maxIntervals N] [--no-save]
  npm run cli -- member  --bits 4 --key 123 [--reportId ID | --intervals '[{\"lo\":\"0\",\"hi\":\"9\"},...]']
  npm run cli -- reports [--limit 50]
  npm run cli -- report  --id ID
  npm run cli -- export  --id ID --out report.json
  npm run cli -- diff    --a ID --b ID
  npm run cli -- help

键一律用十进制字符串；b 取值 1..24；矩形为半开 [xmin,xmax) x [ymin,ymax)。
数据目录默认 ./data，可用环境变量 MORTON_DATA_DIR 覆盖。
`;

function main(): void {
  const [command, ...rest] = process.argv.slice(2);
  const map = argsToMap(rest);

  if (!command || command === "help" || command === "--help" || command === "-h") {
    process.stdout.write(HELP);
    return;
  }

  openDb(join(DATA_DIR, "morton.db"));

  switch (command) {
    case "encode": {
      const grid = makeGrid(Number(need(map, "bits")));
      const x = parseNonNegBigInt(need(map, "x"), "x");
      const y = parseNonNegBigInt(need(map, "y"), "y");
      assertCoord(grid, x, "x");
      assertCoord(grid, y, "y");
      print({ bits: grid.bits, x: x.toString(), y: y.toString(), key: interleave(x, y).toString() });
      break;
    }
    case "decode": {
      const grid = makeGrid(Number(need(map, "bits")));
      const key = parseNonNegBigInt(need(map, "key"), "key");
      assertKeyInRange(grid, key);
      const { x, y } = deinterleave(key, grid.bits);
      print({ bits: grid.bits, key: key.toString(), x: x.toString(), y: y.toString() });
      break;
    }
    case "steps": {
      const grid = makeGrid(Number(need(map, "bits")));
      const x = parseNonNegBigInt(need(map, "x"), "x");
      const y = parseNonNegBigInt(need(map, "y"), "y");
      assertCoord(grid, x, "x");
      assertCoord(grid, y, "y");
      print({
        bits: grid.bits,
        x: x.toString(),
        y: y.toString(),
        key: interleave(x, y).toString(),
        steps: encodeSteps(grid, x, y),
      });
      break;
    }
    case "cover": {
      const bits = Number(need(map, "bits"));
      const { grid, rect } = parseRect(map, bits);
      const budgets: { maxVisited?: number; maxIntervals?: number } = {};
      if (map.has("maxVisited")) budgets.maxVisited = Number(need(map, "maxVisited"));
      if (map.has("maxIntervals")) budgets.maxIntervals = Number(need(map, "maxIntervals"));
      const result = cover(grid, rect, budgets);
      const out = map.has("no-save") ? result : saveReport(result);
      print(out);
      break;
    }
    case "member": {
      const grid = makeGrid(Number(need(map, "bits")));
      const key = parseNonNegBigInt(need(map, "key"), "key");
      assertKeyInRange(grid, key);
      let intervals: Array<{ lo: string; hi: string }>;
      let source: string;
      if (map.has("reportId")) {
        const report = getReport(need(map, "reportId"));
        if (!report) fail(`报告不存在：${map.get("reportId")}`);
        if (report.bits !== grid.bits) fail(`报告 b=${report.bits} 与请求 b=${grid.bits} 不一致`);
        intervals = report.intervals;
        source = report.id;
      } else if (map.has("intervals")) {
        intervals = JSON.parse(need(map, "intervals")) as Array<{ lo: string; hi: string }>;
        source = "inline";
      } else {
        fail("成员核对需要 --reportId 或 --intervals");
      }
      print({ bits: grid.bits, key: key.toString(), member: isCoveredKey(intervals, key), source });
      break;
    }
    case "reports": {
      print({ reports: listReports(Number(map.get("limit") ?? 100)) });
      break;
    }
    case "report": {
      const report = getReport(need(map, "id"));
      if (!report) fail("报告不存在");
      print(report);
      break;
    }
    case "export": {
      const report = getReport(need(map, "id"));
      if (!report) fail("报告不存在");
      const out = need(map, "out");
      writeFileSync(out, JSON.stringify(report, null, 2), "utf8");
      process.stdout.write(`已导出到 ${out}\n`);
      break;
    }
    case "diff": {
      const a = getReport(need(map, "a"));
      const b = getReport(need(map, "b"));
      if (!a || !b) fail("需要两个已存在报告 id");
      print({ a: a.id, b: b.id, comparison: diffReports(a, b) });
      break;
    }
    default:
      fail(`未知命令：${command}\n\n${HELP}`);
  }
}

try {
  main();
  closeDb();
} catch (err) {
  closeDb();
  if ((err as { code?: string }).code && (err as Error).message) {
    const e = err as { code: string; message: string };
    fail(`[${e.code}] ${e.message}`);
  }
  throw err;
}
