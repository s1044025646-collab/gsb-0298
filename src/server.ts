import { createServer, IncomingMessage, Server, ServerResponse } from "node:http";
import { createServer as createNetServer } from "node:net";
import { join } from "node:path";
import {
  assertCoord,
  assertKeyInRange,
  deinterleave,
  encodeSteps,
  Grid,
  interleave,
  makeGrid,
  parseNonNegBigInt,
  ValidationError,
} from "./morton.js";
import { Budgets, cover } from "./cover.js";
import { isCoveredKey } from "./verify.js";
import { closeDb, diffReports, getReport, listReports, openDb, saveReport } from "./db.js";

const DATA_DIR = process.env.MORTON_DATA_DIR ?? join(process.cwd(), "data");
const DB_PATH = join(DATA_DIR, "morton.db");

interface ApiError {
  error: { code: string; message: string; details?: unknown };
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(json);
}

function readJson(req: IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 1_000_000) {
        reject(new ValidationError("PAYLOAD_TOO_LARGE", "请求体超过 1MB 限制"));
        req.destroy();
      }
    });
    req.on("end", () => {
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new ValidationError("INVALID_JSON", "请求体不是合法 JSON"));
      }
    });
    req.on("error", reject);
  });
}

function parseBits(body: any): Grid {
  return makeGrid(Number(body?.bits));
}

function parseCoord(body: any): { grid: Grid; x: bigint; y: bigint } {
  const grid = parseBits(body);
  const x = parseNonNegBigInt(String(body?.x ?? ""), "x");
  const y = parseNonNegBigInt(String(body?.y ?? ""), "y");
  assertCoord(grid, x, "x");
  assertCoord(grid, y, "y");
  return { grid, x, y };
}

function parseKeyFor(grid: Grid, raw: unknown): bigint {
  const key = parseNonNegBigInt(String(raw ?? ""), "key");
  assertKeyInRange(grid, key);
  return key;
}

function parseRect(grid: Grid, body: any) {
  const r = body?.rect ?? body;
  const rect = {
    xmin: parseNonNegBigInt(String(r?.xmin ?? ""), "xmin"),
    xmax: parseNonNegBigInt(String(r?.xmax ?? ""), "xmax"),
    ymin: parseNonNegBigInt(String(r?.ymin ?? ""), "ymin"),
    ymax: parseNonNegBigInt(String(r?.ymax ?? ""), "ymax"),
  };
  // cover 内部还会做网格上界与颠倒校验
  return rect;
}

function parseBudgets(body: any): Partial<Budgets> {
  const out: Partial<Budgets> = {};
  const b = body?.budgets;
  if (b) {
    if (b.maxVisited !== undefined) out.maxVisited = Number(b.maxVisited);
    if (b.maxIntervals !== undefined) out.maxIntervals = Number(b.maxIntervals);
  }
  return out;
}

const routes: Array<{
  method: string;
  pattern: RegExp;
  handler: (req: IncomingMessage, res: ServerResponse, m: RegExpMatchArray, body: any) => void | Promise<void>;
}> = [];

function route(
  method: string,
  pattern: RegExp,
  handler: (req: IncomingMessage, res: ServerResponse, m: RegExpMatchArray, body: any) => void
) {
  routes.push({ method, pattern, handler });
}

route("GET", /^\/health$/, (_req, res) => {
  send(res, 200, { ok: true, ruleVersion: "morton-cover-v1", service: "morton-cover-backend" });
});

route("POST", /^\/api\/encode$/, (_req, res, _m, body) => {
  const { grid, x, y } = parseCoord(body);
  const key = interleave(x, y);
  send(res, 200, { bits: grid.bits, x: x.toString(), y: y.toString(), key: key.toString() });
});

route("POST", /^\/api\/decode$/, (_req, res, _m, body) => {
  const grid = parseBits(body);
  const key = parseKeyFor(grid, body?.key);
  const { x, y } = deinterleave(key, grid.bits);
  send(res, 200, { bits: grid.bits, key: key.toString(), x: x.toString(), y: y.toString() });
});

route("POST", /^\/api\/steps\/encode$/, (_req, res, _m, body) => {
  const { grid, x, y } = parseCoord(body);
  const steps = encodeSteps(grid, x, y);
  send(res, 200, {
    bits: grid.bits,
    x: x.toString(),
    y: y.toString(),
    key: interleave(x, y).toString(),
    convention: "x 的第 i 位 -> 第 2i 位；y 的第 i 位 -> 第 2i+1 位",
    steps,
  });
});

route("POST", /^\/api\/cover$/, (_req, res, _m, body) => {
  const grid = parseBits(body);
  const rect = parseRect(grid, body);
  const budgets = parseBudgets(body);
  const result = cover(grid, rect, budgets);
  const stored = saveReport(result);
  send(res, 200, stored);
});

route("POST", /^\/api\/member$/, (_req, res, _m, body) => {
  const grid = parseBits(body);
  const key = parseKeyFor(grid, body?.key);
  let intervals: any[];
  let source: string;
  if (body?.reportId) {
    const report = getReport(String(body.reportId));
    if (!report) throw new ValidationError("REPORT_NOT_FOUND", `报告 ${String(body.reportId)} 不存在`);
    if (report.bits !== grid.bits) {
      throw new ValidationError(
        "BITS_MISMATCH",
        `报告 b=${report.bits} 与请求 b=${grid.bits} 不一致；旧报告不会按新网格配置重新解释`
      );
    }
    intervals = report.intervals;
    source = report.id;
  } else if (Array.isArray(body?.intervals)) {
    intervals = body.intervals;
    source = "inline";
  } else {
    throw new ValidationError("MISSING_INTERVALS", "成员核对需要 reportId 或 intervals");
  }
  const member = isCoveredKey(intervals, key);
  send(res, 200, { bits: grid.bits, key: key.toString(), member, source });
});

route("GET", /^\/api\/reports$/, (_req, res) => {
  send(res, 200, { reports: listReports() });
});

route("GET", /^\/api\/reports\/([A-Za-z0-9_]+)$/, (_req, res, m) => {
  const report = getReport(m[1]!);
  if (!report) throw new ValidationError("REPORT_NOT_FOUND", `报告 ${m[1]} 不存在`);
  send(res, 200, report);
});

route("GET", /^\/api\/reports\/([A-Za-z0-9_]+)\/export$/, (_req, res, m) => {
  const report = getReport(m[1]!);
  if (!report) throw new ValidationError("REPORT_NOT_FOUND", `报告 ${m[1]} 不存在`);
  send(res, 200, report);
});

route("POST", /^\/api\/reports\/diff$/, (_req, res, _m, body) => {
  const a = getReport(String(body?.a ?? ""));
  const b = getReport(String(body?.b ?? ""));
  if (!a || !b) throw new ValidationError("REPORT_NOT_FOUND", "需要两个已存在的报告 id：a、b");
  send(res, 200, { a: a.id, b: b.id, comparison: diffReports(a, b) });
});

async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  try {
    const body = ["POST", "PUT", "PATCH"].includes(req.method ?? "") ? await readJson(req) : {};
    for (const r of routes) {
      if (r.method !== req.method) continue;
      const m = url.pathname.match(r.pattern);
      if (m) {
        await r.handler(req, res, m, body);
        return;
      }
    }
    send(res, 404, { error: { code: "NOT_FOUND", message: `无此路由：${req.method} ${url.pathname}` } } satisfies ApiError);
  } catch (err) {
    if (err instanceof ValidationError) {
      send(res, 400, { error: { code: err.code, message: err.message, details: err.details } } satisfies ApiError);
    } else {
      const message = err instanceof Error ? err.message : String(err);
      send(res, 500, { error: { code: "INTERNAL", message } } satisfies ApiError);
    }
  }
}

/** 选择一个空闲端口；指定 0 或未指定时由操作系统分配 */
export function pickFreePort(preferred?: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createNetServer();
    srv.on("error", reject);
    srv.listen(preferred ?? 0, "127.0.0.1", () => {
      const addr = srv.address();
      if (addr && typeof addr === "object") {
        const port = addr.port;
        srv.close(() => resolve(port));
      } else {
        reject(new Error("无法获取端口"));
      }
    });
  });
}

export async function startServer(portSpec?: number): Promise<{ server: Server; port: number }> {
  openDb(DB_PATH);
  const requested = portSpec ?? (process.env.PORT ? Number(process.env.PORT) : undefined);
  const port = await pickFreePort(requested);
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  server.on("close", () => closeDb());
  return { server, port };
}

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, "/")}`) {
  startServer()
    .then(({ port }) => {
      console.log(`Morton 覆盖后端已启动： http://127.0.0.1:${port}`);
      console.log(`数据目录： ${DATA_DIR}`);
    })
    .catch((err) => {
      console.error("启动失败：", err);
      process.exit(1);
    });
}
