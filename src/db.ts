// SQLite 持久化：保存每次覆盖分析的独立报告快照。
import { DatabaseSync } from "node:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";
import { RULE_VERSION } from "./morton";
import { CoverResult, Rect } from "./cover";

export interface ReportRow {
  id: number;
  bits: number;
  rect: Rect;
  ruleVersion: string;
  status: string;
  incompleteReason: string | null;
  visited: number;
  pruned: number;
  intervalCount: number;
  coveredPoints: string;
  intervals: unknown;
  createdAt: string;
}

export class ReportStore {
  private db: DatabaseSync;

  constructor(dbPath: string) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS reports (" +
        "id INTEGER PRIMARY KEY AUTOINCREMENT," +
        "bits INTEGER NOT NULL," +
        "rect_json TEXT NOT NULL," +
        "rule_version TEXT NOT NULL," +
        "status TEXT NOT NULL," +
        "incomplete_reason TEXT," +
        "visited INTEGER NOT NULL," +
        "pruned INTEGER NOT NULL," +
        "interval_count INTEGER NOT NULL," +
        "covered_points TEXT NOT NULL," +
        "intervals_json TEXT NOT NULL," +
        "created_at TEXT NOT NULL)"
    );
  }

  saveReport(bits: number, rect: Rect, result: CoverResult): number {
    const stmt = this.db.prepare(
      "INSERT INTO reports (bits, rect_json, rule_version, status, incomplete_reason," +
        " visited, pruned, interval_count, covered_points, intervals_json, created_at)" +
        " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    );
    const info = stmt.run(
      bits,
      JSON.stringify(rect),
      RULE_VERSION,
      result.status,
      result.incompleteReason ?? null,
      result.visited,
      result.pruned,
      result.intervalCount,
      result.coveredPoints,
      JSON.stringify(result.intervals),
      new Date().toISOString()
    );
    return Number(info.lastInsertRowid);
  }

  getReport(id: number): ReportRow | null {
    const row = this.db.prepare("SELECT * FROM reports WHERE id = ?").get(id) as any;
    return row ? this.toReport(row) : null;
  }

  listReports(limit = 50): ReportRow[] {
    const rows = this.db.prepare("SELECT * FROM reports ORDER BY id DESC LIMIT ?").all(limit) as any[];
    return rows.map((r) => this.toReport(r));
  }

  private toReport(row: any): ReportRow {
    return {
      id: row.id,
      bits: row.bits,
      rect: JSON.parse(row.rect_json),
      ruleVersion: row.rule_version,
      status: row.status,
      incompleteReason: row.incomplete_reason,
      visited: row.visited,
      pruned: row.pruned,
      intervalCount: row.interval_count,
      coveredPoints: row.covered_points,
      intervals: JSON.parse(row.intervals_json),
      createdAt: row.created_at,
    };
  }

  close(): void {
    this.db.close();
  }
}
