// HTTP API 服务（仅 Node 内置模块）。
import * as http from "node:http";
import { AddressInfo } from "node:net";
import {
  ApiError,
  RULE_VERSION,
  decode,
  encodeWithSteps,
  parseKey,
  validateBits,
  validateCoord,
} from "./morton";
import { Budget, Rect, coverRect, keyInIntervals } from "./cover";
import { ReportStore } from "./db";

export interface ServerOptions {
  port?: number;
  dbPath: string;
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body, null, 2);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(data);
}

function readBody(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let buf = "";
    req.on("data", (c) => {
      buf += c;
      if (buf.length > 10 * 1024 * 1024) reject(new ApiError("E_BODY", "请求体过大"));
    });
    req.on("end", () => {
      if (!buf) return resolve({});
      try {
        resolve(JSON.parse(buf));
      } catch {
        reject(new ApiError("E_JSON", "请求体不是合法 JSON"));
      }
    });
    req.on("error", reject);
  });
}

function parseBudget(b: any): Budget {
  if (b == null) return {};
  const out: Budget = {};
  const keys = ["maxDepth", "maxVisited", "maxIntervals"] as const;
  for (const k of keys) {
    if (b[k] !== undefined) {
      if (!Number.isInteger(b[k]) || b[k] < 0) throw new ApiError("E_BUDGET", k + " 必须是非负整数");
      out[k] = b[k];
    }
  }
  return out;
}

export function startServer(opts: ServerOptions): Promise<{ server: http.Server; port: number; store: ReportStore }> {
  const store = new ReportStore(opts.dbPath);

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const method = req.method ?? "GET";
      const parts = url.pathname.split("/").filter(Boolean);

      if (method === "GET" && url.pathname === "/health") {
        return json(res, 200, { ok: true, ruleVersion: RULE_VERSION });
      }

      if (method === "POST" && url.pathname === "/encode") {
        const body = await readBody(req);
        const bits = validateBits(body.bits);
        const x = validateCoord(body.x, "x", bits);
        const y = validateCoord(body.y, "y", bits);
        const r = encodeWithSteps(x, y, bits);
        return json(res, 200, { bits, x, y, key: r.key.toString(), steps: r.steps });
      }

      if (method === "POST" && url.pathname === "/decode") {
        const body = await readBody(req);
        const bits = validateBits(body.bits);
        const key = parseKey(body.key, bits);
        const p = decode(key, bits);
        return json(res, 200, { bits, key: key.toString(), x: p.x, y: p.y });
      }

      if (method === "POST" && url.pathname === "/cover") {
        const body = await readBody(req);
        const bits = validateBits(body.bits);
        const rect = body.rect as Rect;
        if (!rect || typeof rect !== "object") throw new ApiError("E_RECT", "缺少 rect 对象");
        const budget = parseBudget(body.budget);
        const result = coverRect(bits, rect, budget);
        const reportId = store.saveReport(bits, rect, result);
        return json(res, 200, Object.assign({ reportId, bits, rect, ruleVersion: RULE_VERSION }, result));
      }

      if (method === "POST" && url.pathname === "/contains") {
        const body = await readBody(req);
        let bits: number;
        let intervals: Array<{ start: string; end: string }>;
        if (body.reportId !== undefined) {
          const report = store.getReport(Number(body.reportId));
          if (!report) throw new ApiError("E_NOT_FOUND", "报告不存在");
          if (report.status !== "complete") {
            throw new ApiError("E_INCOMPLETE", "报告不是完整覆盖，不能用于成员核对");
          }
          bits = report.bits;
          intervals = report.intervals as any;
        } else {
          bits = validateBits(body.bits);
          intervals = body.intervals;
          if (!Array.isArray(intervals)) throw new ApiError("E_INTERVALS", "intervals 必须是数组");
        }
        const key = parseKey(body.key, bits);
        return json(res, 200, { key: key.toString(), contained: keyInIntervals(key, intervals) });
      }

      if (method === "GET" && parts[0] === "reports" && parts.length === 1) {
        return json(res, 200, { reports: store.listReports() });
      }

      if (method === "GET" && parts[0] === "reports" && parts.length === 2) {
        const report = store.getReport(Number(parts[1]));
        if (!report) throw new ApiError("E_NOT_FOUND", "报告不存在");
        return json(res, 200, report);
      }

      if (method === "GET" && parts[0] === "reports" && parts.length === 3 && parts[2] === "export") {
        const report = store.getReport(Number(parts[1]));
        if (!report) throw new ApiError("E_NOT_FOUND", "报告不存在");
        res.writeHead(200, {
          "Content-Type": "application/json; charset=utf-8",
          "Content-Disposition": "attachment; filename=\"report-" + report.id + ".json\"",
        });
        return res.end(JSON.stringify(report, null, 2));
      }

      throw new ApiError("E_ROUTE", "未知路由 " + method + " " + url.pathname);
    } catch (err) {
      if (err instanceof ApiError) {
        json(res, 400, { error: { code: err.code, message: err.message } });
      } else {
        json(res, 500, { error: { code: "E_INTERNAL", message: String(err) } });
      }
    }
  });

  return new Promise((resolve) => {
    server.listen(opts.port ?? 0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      resolve({ server, port, store });
    });
  });
}
