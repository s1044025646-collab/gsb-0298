import { startServer } from "../dist/src/server.js";
import { closeDb } from "../dist/src/db.js";

const { server, port } = await startServer();
const base = `http://127.0.0.1:${port}`;

async function call(path, body) {
  const res = await fetch(base + path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json();
  return { status: res.status, json };
}
async function get(path) {
  const res = await fetch(base + path);
  return { status: res.status, json: await res.json() };
}

console.log("health:", (await get("/health")).status);
console.log("encode:", JSON.stringify((await call("/api/encode", { bits: 2, x: "1", y: "0" })).json));
console.log("decode:", JSON.stringify((await call("/api/decode", { bits: 2, key: "3" })).json));
const cover = await call("/api/cover", {
  bits: 4,
  xmin: "1", xmax: "14", ymin: "2", ymax: "13",
  budgets: { maxVisited: 100000 },
});
console.log("cover:", cover.json.status, "区间", cover.json.stats.intervalsOut, "面积", cover.json.area, "id", cover.json.id);
const member = await call("/api/member", { bits: 4, key: cover.json.intervals[0].lo, reportId: cover.json.id });
console.log("member(lo):", JSON.stringify(member.json));
const outsider = await call("/api/member", { bits: 4, key: "0", reportId: cover.json.id });
console.log("member(0):", JSON.stringify(outsider.json));
const badBits = await call("/api/cover", { bits: 99, xmin: "0", xmax: "1", ymin: "0", ymax: "1" });
console.log("bad bits:", badBits.status, badBits.json.error.code);
const badKey = await call("/api/decode", { bits: 2, key: "99" });
console.log("bad key:", badKey.status, badKey.json.error.code);
const list = await get("/api/reports");
console.log("reports count:", list.json.reports.length);
const exp = await get(`/api/reports/${cover.json.id}/export`);
console.log("export:", exp.status, exp.json.bits === 4 ? "snapshot-ok" : "BAD");
server.close(() => {
  closeDb();
});
