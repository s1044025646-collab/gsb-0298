# Morton 网格编码与矩形区间覆盖后端

纯本地运行的二维整数网格 Morton（Z-order）编码服务。TypeScript + Node.js + SQLite（`node:sqlite`，无原生依赖、无 Docker、无外部在线 API）。只提供 HTTP API 与 CLI，无前端。

## 功能

- 边长 2^b（b = 1..24）正方形网格上的 Morton 编码 / 解码：x 的第 i 位放在键的第 2i 位，y 的第 i 位放在第 2i+1 位。
- 键以十进制字符串输入输出，内部全部使用 BigInt，不依赖 32 位位运算保存大键。
- 轴对齐查询矩形（半开边界 `[xmin,xmax) x [ymin,ymax)`）的精确键区间覆盖：
  按 Morton 前缀递归遍历四叉树——子块完全在外则跳过，完全包含则输出连续闭键区间，部分相交则细分。
  输出按起点递增并合并相邻区间，不重复、不漏点、不含矩形外的点。
- 每个区间附带来源层级、二进制前缀、对应子块与判定理由；可查询单点逐位编码过程。
- 预算控制：`maxDepth` / `maxVisited` / `maxIntervals`，超限返回 `incomplete` 状态与计数，绝不把部分覆盖当作完整结果。
- SQLite 持久化：网格位数、原始矩形、规则版本（`morton-xy-interleave-v1`）、覆盖状态与结果快照。
  每次分析是独立报告，可比较；报告自带 bits，修改网格配置不会重新解释旧键。
- 成员核对、历史列表、JSON 导出；参数校验与明确错误码；默认自动选择空闲端口；数据目录在项目内 `data/`。

## 环境要求

- Windows + Node.js >= 22.5（推荐 23+，本仓库在 Node 25 上验证）。无需任何原生编译或付费服务。

## 常用命令

```powershell
npm install        # 安装开发依赖（typescript、@types/node）
npm run build      # 编译到 dist/
npm test           # 构建并运行全部测试
npm start          # 启动 HTTP 服务（自动选择空闲端口）
npm run demo       # 构建并运行演示脚本
```

CLI 直接使用：

```powershell
node dist/src/cli.js encode --bits 2 --x 1 --y 0        # -> key "1"，含逐位步骤
node dist/src/cli.js decode --bits 2 --key 3            # -> {x:1, y:1}
node dist/src/cli.js cover --bits 2 --xmin 1 --ymin 0 --xmax 3 --ymax 4
node dist/src/cli.js cover --bits 8 --xmin 1 --ymin 1 --xmax 200 --ymax 200 --maxIntervals 3
node dist/src/cli.js contains --reportId 1 --key 9
node dist/src/cli.js reports
node dist/src/cli.js export --id 1 --out report.json
node dist/src/cli.js serve --port 8080                  # 缺省 --port 时自动选空闲端口
node dist/src/cli.js demo
```

通用参数 `--db PATH` 指定数据库文件（默认 `data/morton.db`）。

## HTTP API

所有请求/响应均为 JSON。错误响应形如 `{"error":{"code":"E_BITS_RANGE","message":"..."}}`，HTTP 400。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/health` | 健康检查与规则版本 |
| POST | `/encode` | `{bits,x,y}` -> `{key, steps}`（逐位编码过程） |
| POST | `/decode` | `{bits,key}` -> `{x,y}` |
| POST | `/cover` | `{bits,rect:{xmin,ymin,xmax,ymax},budget?}` -> 区间集合并落库，返回 `reportId` |
| POST | `/contains` | `{key, reportId}` 或 `{bits,key,intervals}` -> `{contained}` |
| GET | `/reports` | 历史报告列表 |
| GET | `/reports/:id` | 单个报告快照 |
| GET | `/reports/:id/export` | 下载报告 JSON |

示例：

```powershell
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:<端口>/cover -ContentType 'application/json' -Body '{"bits":2,"rect":{"xmin":1,"ymin":0,"xmax":3,"ymax":4}}'
```

## 错误码

`E_BITS_TYPE` / `E_BITS_RANGE`（bits 非整数或超出 1..24）、`E_COORD` / `E_COORD_RANGE`、
`E_KEY_SYNTAX` / `E_KEY_RANGE`、`E_RECT_COORD` / `E_RECT_INVERTED` / `E_RECT_OUT_OF_GRID`、
`E_BUDGET`、`E_INCOMPLETE`（对未完成报告做成员核对）、`E_NOT_FOUND`、`E_JSON` / `E_BODY` / `E_ROUTE`。
校验失败不会写出任何可能被误认为完整覆盖的结果。

## 覆盖算法说明

从根节点（整个 2^b x 2^b 网格，空前缀）开始递归：

1. 子块与查询矩形不相交 -> 剪枝跳过；
2. 子块完全被包含 -> 输出闭区间 `[prefix << 2(b-level), 起点 + 块面积 - 1]`；
3. 部分相交 -> 按象限位（x 低位、y 高位，与编码规则一致）细分为 4 个子块继续；
4. 叶子（1x1）直接判定。最后按起点排序合并相邻区间。

区间数量随形状变化：与 2 的幂边界对齐的方块只需 1 个区间；错位方块、细条会因 Z 序在象限边界跳变而产生更多区间（演示脚本中有定量对比）。

## 项目结构

```
src/morton.ts   位交织/反交织、校验、错误码、逐位步骤
src/cover.ts    四叉树递归覆盖、预算、区间合并、成员核对
src/db.ts       SQLite 报告快照
src/server.ts   HTTP API（Node 内置 http）
src/cli.ts      命令行入口
src/demo.ts     演示脚本
test/run-tests.ts  测试（含暴力逐点对照）
data/           本地数据库目录
```

## 限制

- 仅处理离散整数网格，不做经纬度转换、图层编辑、距离查询或地图集成。
- 坐标以 number 输入（b<=24 时最大 2^24-1，安全）；键一律用十进制字符串。
- `node:sqlite` 在 Node 25 仍打印 ExperimentalWarning，属正常提示。
- 覆盖结果为内存中返回并整体快照入库；超大区间数量请用预算参数保护。
