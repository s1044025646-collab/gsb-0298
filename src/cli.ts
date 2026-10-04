// CLI 入口：encode / decode / cover / contains / reports / export / serve / demo
import * as path from "node:path";
import * as fs from "node:fs";
import { decode, encodeWithSteps, parseKey, validateBits, validateCoord } from "./morton";
import { Budget, Rect, coverRect, keyInIntervals } from "./cover";
import { ReportStore } from "./db";
import { startServer } from "./server";
import { runDemo } from "./demo";

const DB_PATH = path.join(process.cwd(), "data", "morton.db");

function argValue(args: string[], name: string): string | undefined {
  const i = args.indexOf("--" + name);
  return i >= 0 ? args[i + 1] : undefined;
}

function need(args: string[], name: string): string {
  const v = argValue(args, name);
  if (v === undefined) throw new Error("缺少参数 --" + name);
  return v;
}

function out(v: unknown): void {
  console.log(JSON.stringify(v, null, 2));
}

async function main(): Promise<void> {
  const [cmd, ...args] = process.argv.slice(2);
  const dbPath = argValue(args, "db") ?? DB_PATH;

  switch (cmd) {
    case "encode": {
      const bits = validateBits(Number(need(args, "bits")));
      const x = validateCoord(Number(need(args, "x")), "x", bits);
      const y = validateCoord(Number(need(args, "y")), "y", bits);
      const r = encodeWithSteps(x, y, bits);
      out({ bits, x, y, key: r.key.toString(), steps: r.steps });
      break;
    }
    case "decode": {
      const bits = validateBits(Number(need(args, "bits")));
      const key = parseKey(need(args, "key"), bits);
      out({ bits, key: key.toString(), ...decode(key, bits) });
      break;
    }
    case "cover": {
      const bits = validateBits(Number(need(args, "bits")));
      const rect: Rect = {
        xmin: Number(need(args, "xmin")),
        ymin: Number(need(args, "ymin")),
        xmax: Number(need(args, "xmax")),
        ymax: Number(need(args, "ymax")),
      };
      const budget: Budget = {};
      for (const k of ["maxDepth", "maxVisited", "maxIntervals"] as const) {
        const v = argValue(args, k);
        if (v !== undefined) budget[k] = Number(v);
      }
      const result = coverRect(bits, rect, budget);
      const store = new ReportStore(dbPath);
      const reportId = store.saveReport(bits, rect, result);
      store.close();
      out({ reportId, bits, rect, ...result });
      break;
    }
    case "contains": {
      const reportId = argValue(args, "reportId");
      const store = new ReportStore(dbPath);
      let bits: number;
      let intervals: Array<{ start: string; end: string }>;
      if (reportId !== undefined) {
        const report = store.getReport(Number(reportId));
        if (!report) throw new Error("报告不存在");
        if (report.status !== "complete") throw new Error("报告不是完整覆盖，不能用于成员核对");
        bits = report.bits;
        intervals = report.intervals as any;
      } else {
        bits = validateBits(Number(need(args, "bits")));
        intervals = JSON.parse(need(args, "intervals"));
      }
      const key = parseKey(need(args, "key"), bits);
      store.close();
      out({ key: key.toString(), contained: keyInIntervals(key, intervals) });
      break;
    }
    case "reports": {
      const store = new ReportStore(dbPath);
      out(store.listReports().map((r) => ({
        id: r.id, bits: r.bits, rect: r.rect, status: r.status,
        intervalCount: r.intervalCount, coveredPoints: r.coveredPoints, createdAt: r.createdAt,
      })));
      store.close();
      break;
    }
    case "export": {
      const store = new ReportStore(dbPath);
      const report = store.getReport(Number(need(args, "id")));
      store.close();
      if (!report) throw new Error("报告不存在");
      const file = argValue(args, "out") ?? "report-" + report.id + ".json";
      fs.writeFileSync(file, JSON.stringify(report, null, 2), "utf-8");
      console.log("已导出 " + file);
      break;
    }
    case "serve": {
      const portArg = argValue(args, "port");
      const started = await startServer({ port: portArg ? Number(portArg) : 0, dbPath });
      console.log("Morton 服务已启动: http://127.0.0.1:" + started.port + " (数据库: " + dbPath + ")");
      break;
    }
    case "demo": {
      await runDemo(dbPath);
      break;
    }
    default:
      console.log([
        "用法: node dist/src/cli.js <命令> [参数]",
        "  encode   --bits N --x X --y Y",
        "  decode   --bits N --key K",
        "  cover    --bits N --xmin A --ymin B --xmax C --ymax D [--maxDepth|--maxVisited|--maxIntervals]",
        "  contains --key K (--reportId ID | --bits N --intervals JSON)",
        "  reports",
        "  export   --id ID [--out FILE]",
        "  serve    [--port P]   (缺省自动选择空闲端口)",
        "  demo",
        "通用参数: --db PATH (默认 data/morton.db)",
      ].join("\n"));
  }
}

main().catch((err) => {
  console.error("错误:", err.code ? err.code + ": " + err.message : err.message);
  process.exit(1);
});
