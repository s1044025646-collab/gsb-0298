import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { CoverResult } from "./cover.js";

export const RULE_VERSION = "morton-cover-v1";

export interface StoredReport extends CoverResult {
  id: string;
  ruleVersion: string;
  createdAt: string;
}

let dbInstance: DatabaseSync | undefined;

export function openDb(dbPath: string): DatabaseSync {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec(`
    CREATE TABLE IF NOT EXISTS reports (
      id TEXT PRIMARY KEY,
      rule_version TEXT NOT NULL,
      bits INTEGER NOT NULL,
      rect_json TEXT NOT NULL,
      status TEXT NOT NULL,
      area TEXT NOT NULL,
      reason TEXT,
      stats_json TEXT NOT NULL,
      budgets_json TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
    CREATE TABLE IF NOT EXISTS report_intervals (
      report_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      lo TEXT NOT NULL,
      hi TEXT NOT NULL,
      points TEXT NOT NULL,
      blocks_json TEXT NOT NULL,
      PRIMARY KEY (report_id, seq),
      FOREIGN KEY (report_id) REFERENCES reports(id) ON DELETE CASCADE
    );
  `);
  dbInstance = db;
  return db;
}

export function getDb(): DatabaseSync {
  if (!dbInstance) throw new Error("数据库尚未初始化，请先调用 openDb()");
  return dbInstance;
}

/** 显式关闭，规避 Windows 上实验性 node:sqlite 退出期句柄断言 */
export function closeDb(): void {
  if (dbInstance) {
    dbInstance.close();
    dbInstance = undefined;
  }
}

function newId(): string {
  return `rpt_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * 保存一次覆盖分析。完整与未完成都会落库，但 status 明确区分，
 * 未完成报告不带区间快照，避免被误当成完整覆盖。
 */
export function saveReport(result: CoverResult): StoredReport {
  const db = getDb();
  const id = newId();
  const createdAt = new Date().toISOString();
  const insertReport = db.prepare(`
    INSERT INTO reports (id, rule_version, bits, rect_json, status, area, reason, stats_json, budgets_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertIv = db.prepare(`
    INSERT INTO report_intervals (report_id, seq, lo, hi, points, blocks_json)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  const tx = db.prepare("BEGIN");
  const commit = db.prepare("COMMIT");
  const rollback = db.prepare("ROLLBACK");
  tx.run();
  try {
    insertReport.run(
      id,
      RULE_VERSION,
      result.bits,
      JSON.stringify(result.rect),
      result.status,
      result.area,
      result.reason ?? null,
      JSON.stringify(result.stats),
      JSON.stringify(result.budgets),
      createdAt
    );
    if (result.status === "complete") {
      result.intervals.forEach((iv, seq) => {
        insertIv.run(id, seq, iv.lo, iv.hi, iv.points, JSON.stringify(iv.blocks));
      });
    }
    commit.run();
  } catch (err) {
    rollback.run();
    throw err;
  }

  return { ...result, id, ruleVersion: RULE_VERSION, createdAt };
}

export interface ReportSummary {
  id: string;
  ruleVersion: string;
  bits: number;
  rect: CoverResult["rect"];
  status: CoverResult["status"];
  area: string;
  reason: string | null;
  stats: CoverResult["stats"];
  intervalsOut: number;
  createdAt: string;
}

export function listReports(limit = 100): ReportSummary[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT r.*, (SELECT COUNT(*) FROM report_intervals i WHERE i.report_id = r.id) AS iv_count
       FROM reports r ORDER BY r.created_at DESC, r.id DESC LIMIT ?`
    )
    .all(limit) as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    id: String(row.id),
    ruleVersion: String(row.rule_version),
    bits: Number(row.bits),
    rect: JSON.parse(String(row.rect_json)) as CoverResult["rect"],
    status: String(row.status) as CoverResult["status"],
    area: String(row.area),
    reason: (row.reason as string | null) ?? null,
    stats: JSON.parse(String(row.stats_json)) as CoverResult["stats"],
    intervalsOut: Number(row.iv_count),
    createdAt: String(row.created_at),
  }));
}

export function getReport(id: string): StoredReport | undefined {
  const db = getDb();
  const row = db.prepare("SELECT * FROM reports WHERE id = ?").get(id) as
    | Record<string, unknown>
    | undefined;
  if (!row) return undefined;
  const ivRows = db
    .prepare("SELECT lo, hi, points, blocks_json FROM report_intervals WHERE report_id = ? ORDER BY seq")
    .all(id) as Array<Record<string, unknown>>;
  const intervals = ivRows.map((r) => ({
    lo: String(r.lo),
    hi: String(r.hi),
    points: String(r.points),
    blocks: JSON.parse(String(r.blocks_json)),
  }));
  return {
    id: String(row.id),
    ruleVersion: String(row.rule_version),
    createdAt: String(row.created_at),
    bits: Number(row.bits),
    rect: JSON.parse(String(row.rect_json)),
    status: String(row.status) as CoverResult["status"],
    area: String(row.area),
    reason: (row.reason as string | null) ?? undefined,
    intervals,
    stats: JSON.parse(String(row.stats_json)),
    budgets: JSON.parse(String(row.budgets_json)),
  };
}

/** 比较两次独立报告：仅在相同 bits 下比较才完全有意义 */
export function diffReports(a: StoredReport, b: StoredReport): {
  sameBits: boolean;
  sameRect: boolean;
  sameStatus: boolean;
  sameIntervalCount: boolean;
  identicalIntervals: boolean;
} {
  const sameRect = JSON.stringify(a.rect) === JSON.stringify(b.rect);
  const ivA = JSON.stringify(a.intervals.map((i) => [i.lo, i.hi]));
  const ivB = JSON.stringify(b.intervals.map((i) => [i.lo, i.hi]));
  return {
    sameBits: a.bits === b.bits,
    sameRect,
    sameStatus: a.status === b.status,
    sameIntervalCount: a.intervals.length === b.intervals.length,
    identicalIntervals: ivA === ivB,
  };
}
