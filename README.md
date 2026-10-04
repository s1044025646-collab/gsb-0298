# Morton 网格编码与矩形区间覆盖后端

二维整数网格的 Morton（Z-order）编码服务：坐标编码、键解码、为轴对齐查询矩形生成
**精确** 的闭键区间集合。只有 API（HTTP/JSON）与 CLI，没有前端、没有地图库、
不做经纬度/距离/图层。使用 TypeScript + Node.js 内置 `node:sqlite`，
**无需 Docker、WSL、原生编译或任何在线服务**，Windows 本地直接运行。

## 1. 环境要求

- Node.js **>= 22.5**（内置实验性 `node:sqlite`；开发与验证使用 Node v25）。
- 首次运行需 `npm install` 拉取 `typescript` / `tsx` 等开发依赖（仅安装时联网）。

> 运行时会看到一条 `SQLite is an experimental feature` 警告，属正常提示，不影响功能。

## 2. 快速开始

```powershell
npm install
npm run demo      # 演示 + 自检（推荐先跑）
npm test          # 运行全部测试
npm run build     # 类型检查并编译到 dist/
npm start         # 启动 HTTP 服务（默认自动选择空闲端口）
```

启动后控制台打印实际地址，例如 `http://127.0.0.1:51234`。

- 端口：设置环境变量 `PORT=8080 npm start` 指定；不指定时由操作系统分配空闲端口。
- 数据目录：默认项目内 `./data`（SQLite 文件 `data/morton.db`），
  可用环境变量 `MORTON_DATA_DIR` 覆盖。

## 3. 编码约定

- 网格边长 `2^b`，`b ∈ [1,24]`；坐标为非负整数，范围 `[0, 2^b-1]`。
- 键为 `2b` 位非负整数，对外一律用**十进制字符串**，内部全程 `BigInt`，
  不使用 JavaScript 32 位位运算保存大键。
- 交织规则：`x` 的第 `i` 位放在键的第 `2i` 位；`y` 的第 `i` 位放在第 `2i+1` 位。
- `b=2` 核对：`(0,0)->0`、`(1,0)->1`、`(0,1)->2`、`(1,1)->3`。

## 4. 矩形覆盖算法

查询使用**半开**矩形 `[xmin,xmax) × [ymin,ymax)`：

- `xmin==xmax` 或 `ymin==ymax` 是合法空矩形（结果为 0 个区间）；
- 边界颠倒（`xmin>xmax` 等）或超过网格上界 `2^b` 一律拒绝。

核心是矩形与四叉子区块的递归关系（按 Morton 前缀深度优先遍历）：

1. 子块完全在矩形外 → **跳过**；
2. 子块完全被包含 → 直接输出它的**连续键区间**
   `[prefix << 2(b-d), (prefix+1) << 2(b-d) - 1]`；
3. 部分相交 → 细分为四个子块（Morton 子序 `00,01,10,11`）继续递归。

输出的闭区间按起点递增，并合并键上相邻（`hi+1 == lo`）的区间。
最终集合保证：**不重复、不包含矩形外的点、无遗漏**。
每个区间都带 `blocks` 来源：层级 `depth`、Morton `prefix`、子块左下角 `(ox,oy)`、
边长 `side`，说明该区间来自哪一级前缀及判定（满块包含/边界合并）。

**为什么不是取两角点的最小/最大键？** Morton 序在四象限边界不连续，
单一大区间会包住大量矩形外的点；本算法通过细分只输出真正落在矩形内的连续段。
例如 `b=2` 的细条 `[0,4)×[1,2)` 横跨四个象限，产生 `[2,3]` 与 `[6,7]` 两个区间。

### 预算与未完成状态

可配置预算（请求体 `budgets` 或 CLI 参数）：

- `maxVisited`：最多访问的四叉节点数（默认 `2_000_000`）；
- `maxIntervals`：最多输出满块数（默认 `500_000`）。

超限时返回 `status="incomplete"`、`reason` 与已访问/计数统计，
**不返回任何部分区间**，绝不会把部分覆盖伪装成完整结果。

## 5. HTTP API

所有请求/响应均为 JSON，键与坐标使用十进制字符串。错误统一为
`400 { "error": { "code", "message" } }`。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/health` | 健康检查与规则版本 |
| POST | `/api/encode` | `{bits,x,y}` → `{key}` |
| POST | `/api/decode` | `{bits,key}` → `{x,y}` |
| POST | `/api/steps/encode` | 单坐标逐位编码过程 |
| POST | `/api/cover` | 矩形覆盖（落库为一份报告） |
| POST | `/api/member` | 键是否属于区间（`reportId` 或内联 `intervals`） |
| GET | `/api/reports` | 历史报告列表 |
| GET | `/api/reports/:id` | 报告详情（含区间快照） |
| GET | `/api/reports/:id/export` | JSON 导出 |
| POST | `/api/reports/diff` | 比较两份独立报告 `{a,b}` |

覆盖请求示例：

```json
{
  "bits": 4,
  "xmin": "1", "xmax": "14", "ymin": "2", "ymax": "13",
  "budgets": { "maxVisited": 1000000, "maxIntervals": 200000 }
}
```

响应关键字段：`status`、`intervals[]`（`lo/hi/points/blocks`）、
`stats`（`visited/emittedBlocks/intervalsOut/pointsCovered/maxDepth/skipped/fullyContained`）、
`area`、`reason?`、`id`、`ruleVersion`、`createdAt`。

### 配置不可变

报告固化了 `bits`、原始矩形与 `ruleVersion`。读取旧报告做成员核对时若 `bits`
与当前请求不一致，返回 `BITS_MISMATCH`——**修改网格配置不会重新解释旧键**。
重复分析会生成带独立 `id` 的新报告，可用 `/api/reports/diff` 比较。

## 6. CLI

```powershell
npm run cli -- encode --bits 2 --x 1 --y 0
npm run cli -- decode --bits 2 --key 3
npm run cli -- steps  --bits 3 --x 5 --y 2
npm run cli -- cover  --bits 4 --xmin 1 --xmax 6 --ymin 0 --ymax 3
npm run cli -- cover  --bits 4 --xmin 1 --xmax 6 --ymin 0 --ymax 3 --maxVisited 1000 --no-save
npm run cli -- member --bits 4 --key 123 --reportId rpt_xxx
npm run cli -- reports
npm run cli -- report --id rpt_xxx
npm run cli -- export --id rpt_xxx --out report.json
npm run cli -- diff   --a rpt_aaa --b rpt_bbb
npm run cli -- help
```

`cover` 默认写入 SQLite；加 `--no-save` 只计算不落库。

## 7. 错误码

| code | 含义 |
| --- | --- |
| `BITS_OUT_OF_RANGE` | b 不是 1..24 的整数 |
| `INVALID_INTEGER` | 坐标/键不是非负十进制整数字符串 |
| `COORD_OUT_OF_RANGE` | 坐标超过 `2^b-1` |
| `KEY_OUT_OF_RANGE` | 键超过 `2^(2b)-1` |
| `RECT_INVERTED` | 矩形边界颠倒 |
| `RECT_OUT_OF_GRID` | 边界超过网格上界 `2^b` |
| `INVALID_BUDGET` | 预算不是正整数 |
| `MISSING_INTERVALS` | 成员核对缺少 `reportId/intervals` |
| `REPORT_NOT_FOUND` | 报告 id 不存在 |
| `BITS_MISMATCH` | 报告与请求的网格位数不一致 |
| `INVALID_JSON` / `PAYLOAD_TOO_LARGE` / `NOT_FOUND` / `INTERNAL` | 传输与服务端错误 |

校验失败在任何写库前抛出，不会产生可被误认为完整覆盖的记录。

## 8. 数据模型（SQLite）

- `reports`：`id`、`rule_version`、`bits`、原始矩形 `rect_json`、
  `status`（complete/incomplete）、`area`、`reason`、统计与预算快照、时间戳。
- `report_intervals`：每个完整报告的区间行（`lo/hi/points/blocks_json`）。
  未完成报告不写区间行。

## 9. 测试与正确性验证

`npm test` 覆盖：

- `b=2` 四个基准编码与 `b=24` 大键往返（高位不丢失）；
- 小网格（`b<=4`）**独立枚举所有格点**，用普通半开矩形包含判断与
  区间成员结果逐点比对：假阳性=0、遗漏=0、重叠=0；
- 区间展开点数恒等于矩形面积 `(xmax-xmin)*(ymax-ymin)`；
- 单点、零宽空矩形、全网格、边界相邻拼接、细条多区间；
- 预算耗尽返回 `incomplete` 且无区间；
- 颠倒/越界/非法键拒绝；
- SQLite 保存后“重启”（重新打开同一库）读取原报告。

`npm run demo` 会把上述内容以可读形式完整演示一遍。

## 10. 区间数量随形状变化（b=3 示例）

| 形状 | 面积 | 区间数 |
| --- | --- | --- |
| 全网格 `[0,8)²` | 64 | 1 |
| 内嵌方块 `[1,7)²` | 36 | 16 |
| 整宽横条 `[0,8)×[3,4)` | 8 | 4 |
| 整高竖条 `[3,4)×[0,8)` | 8 | 8 |

与四叉块对齐的形状区间少；跨分区边界、尤其在奇数坐标切分的细条带区间更多。

## 11. 范围与限制

- 只处理离散整数网格；不含经纬度投影、图层编辑、距离查询或外部地图依赖。
- 上限 `b=24`（单网格最多 `2^48` 个键），超出按 `BITS_OUT_OF_RANGE` 拒绝。
- 覆盖是精确算法；极端碎片化矩形在大 `b` 下区间数可能很大，请用预算控制，
  并以 `incomplete` 状态显式告知调用方。
- `node:sqlite` 在当前 Node 版本标记为实验性；服务端长期运行建议关注 Node 升级说明。

## 12. 目录结构

```
src/
  morton.ts   位交织/反交织、网格与校验、逐位步骤
  cover.ts    四叉树递归覆盖、预算、区间合并与来源
  verify.ts   键成员、逐点枚举核对
  db.ts       SQLite 持久化与报告比较
  server.ts   HTTP API、错误码、空闲端口
  cli.ts      命令行
  demo.ts     演示与自检
tests/        node:test 测试
scripts/      冒烟脚本
data/         运行时生成（已 gitignore）
```
