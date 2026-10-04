import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cover } from "../src/cover.js";
import { makeGrid } from "../src/morton.js";
import { getReport, listReports, openDb, RULE_VERSION, saveReport } from "../src/db.js";

test("报告保存、重启读取、未完成标记", () => {
  const dir = mkdtempSync(join(tmpdir(), "morton-db-"));
  openDb(join(dir, "t.db"));
  const g = makeGrid(4);
  const r = { xmin: 1n, xmax: 14n, ymin: 2n, ymax: 13n };
  const saved = saveReport(cover(g, r));
  assert.equal(saved.ruleVersion, RULE_VERSION);

  const partial = saveReport(cover(g, r, { maxVisited: 3, maxIntervals: 10 }));
  assert.equal(partial.status, "incomplete");
  assert.equal(partial.intervals.length, 0);

  openDb(join(dir, "t.db"));
  const got = getReport(saved.id);
  assert.ok(got);
  assert.equal(got!.bits, 4);
  assert.equal(got!.intervals.length, saved.intervals.length);
  const list = listReports();
  assert.ok(list.some((x) => x.id === partial.id && x.status === "incomplete"));
});
