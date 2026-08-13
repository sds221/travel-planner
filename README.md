# 行程规划

选景点 → 选酒店 → 生成最优路线。三步耦合在同一个行程对象上，上游改动会让下游结果失效并要求重算。

## 分工

这个项目的核心设计是**把组合优化交给算法，把理解意图和解释结果交给 LLM**：

| 任务 | 负责方 | 原因 |
| --- | --- | --- |
| 理解"带老人、不想太累、喜欢历史" | LLM | 没法用规则表达 |
| 景点/酒店检索 | 高德 Web 服务 API | 需要真实 POI 和坐标 |
| 分天聚类 + 访问顺序 | k-means + 2-opt | 可复现、次优解可控 |
| 时刻表（含营业时间、超时截断） | 纯函数调度器 | 必须自洽，不能出现 14:00 到、13:30 走 |
| 评估方案、写每天主题和提醒 | LLM | 这是它真正擅长的 |

LLM 不排时刻表。它可以多次调用求解器试算不同参数（交通方式、天数），但最终写库的是算法输出。

## 起步

```bash
pnpm install
cp .env.example .env          # 填 LLM_API_KEY 和两个高德 key
pnpm db:up                    # 起 PostGIS + Redis（端口 5433/6380）
pnpm db:migrate               # 建表
pnpm db:seed                  # 5 个城市的种子景点（含营业时间）
pnpm dev
```

### 没有 Docker / 不想装 PostGIS

PostGIS 在 Homebrew 上要拉 131 个依赖（llvm、boost、aws-sdk-cpp，好几 GB）。只想在本地跑起来看看的话可以用简化模式：

```bash
brew install postgresql@17     # 只有 11 个依赖
brew services start postgresql@17
psql -d postgres -c "CREATE ROLE travel LOGIN PASSWORD 'travel' CREATEDB"
createdb -O travel travel_planner

# .env 里改两处
DATABASE_URL=postgresql://travel:travel@localhost:5432/travel_planner
DB_GEO_MODE=plain

pnpm db:generate && pnpm db:migrate && pnpm db:seed
```

`DB_GEO_MODE=plain` 把 `geography` 列换成 `jsonb`，半径过滤用经纬度包围盒（B-tree 索引），精确距离用 SQL 里手写的 haversine。城市尺度上和 PostGIS 的椭球距离差 0.3% 以内，对"挑离景点近的酒店"没有实际影响；代价是几十万条 POI 时明显变慢。**生产环境用 postgis 模式**。切换模式要重建表（列类型不同）。

### 缺 key 时还能做什么

各能力独立降级，不会因为少配一个 key 就整个不可用：

| 缺什么 | 影响 |
| --- | --- |
| `LLM_API_KEY` | 行程照样生成（顺序和时刻表本来就是算法算的），只是没有 AI 评估和每天的主题文案 |
| `AMAP_SERVER_KEY` | 通勤时间退化为直线估算，地图上没有真实路径折线；景点搜索拿不到数据，但种子景点和手动导入仍可用 |
| `NEXT_PUBLIC_AMAP_JS_KEY` | 地图不渲染，行程明细正常 |
| `ARK_API_KEY` | 房价退回模型行情估价或系数粗估 |

环境变量按能力分组校验（`src/lib/env.ts`），所以"只想看行程列表"不会因为没配 LLM key 而报错——这是之前踩过的坑。

### 需要的凭据

- **LLM**（必需）：任何 OpenAI 兼容接口。默认 DeepSeek（`https://api.deepseek.com/v1` + `deepseek-chat`），换通义/月之暗面只改 `.env`。
- **高德**（必需）：两个 key。`AMAP_SERVER_KEY` 是 Web 服务类型（后端 POI/路径规划），`NEXT_PUBLIC_AMAP_JS_KEY` 是 Web 端 JS 类型（前端渲染），后者还要配套 `NEXT_PUBLIC_AMAP_JS_SECURITY_CODE`。两种 key 不通用。
- **火山方舟**（可选）：`ARK_API_KEY` 用于联网查房价。不配就退回模型行情估价，功能不受影响但价格标注会变（见下）。

Redis 可选：没配 `REDIS_URL` 或连不上会退化为进程内缓存，重启丢缓存但功能不受影响。房价缓存 6 小时——比 POI 短得多，缓存太久就失去"实时"的意义。

想完全离线跑（不烧 token）：`PRICE_MODE=formula`。

## 三个步骤

**第一步 选景点** —— 三个并列入口：AI 推荐（`POST /api/trips/:id/recommend-pois`）、单个补充、批量导入清单（`POST /api/trips/:id/import`，把小红书收藏那样的一段文本逐行定位）。推荐结果需要用户勾选才落库，agent 的建议是可以被拒绝的。

**第二步 选酒店** —— 搜索中心是已选景点的地理重心，"位置分"就是到这些景点的平均通勤距离。所以这一步硬依赖第一步，没选景点会返回 409 而不是退化成搜市中心。

**第三步 生成路线** —— agent 试算若干组参数，定稿后用它选定的参数重算一遍（这次带真实路径折线）再落库。

## 关于房价

高德提供真实的酒店位置、品牌、星级，但不提供房价。房价走独立的 `PriceProvider` 链，按可信度降级：

| 来源 | 实现 | 可信度 | UI 标注 |
| --- | --- | --- | --- |
| `ota` | 未实现 | 可下单价格 | 平台报价 |
| `search` | [price-search.ts](src/lib/providers/price-search.ts) 火山方舟 `web_search` | 现场搜到的平台展示价，**带来源链接** | 联网查价 |
| `llm` | [price-llm.ts](src/lib/providers/price-llm.ts) 主模型 | 训练数据里的行情记忆，无来源 | 行情估价 |
| `formula` | [hotel-pricing.ts](src/lib/providers/hotel-pricing.ts) 星级×品牌×城市系数 | 量级正确，单店不准 | 粗估价 |

**为什么查价要单独配一份凭据**：只有火山方舟(豆包)的 Responses API 有内置 `web_search` 工具([文档](https://www.volcengine.com/docs/82379/1756990))，而且能和自定义 function 并存。DeepSeek 的联网只在网页版/App，`/chat/completions` 没有——让它"查"房价，拿到的是训练记忆而不是实时价。所以主模型（推理、文案）和查价模型是分开的。

链式降级不是可选优化：联网查价慢、会限流、按次计费，一批 20 家查到 15 家是常态。剩下 5 家如果直接空着，UI 就是"部分酒店没价格"，比给个粗估更难用。所以**每家酒店独立降级**，`priceSource` 逐条标注，UI 据此区分显示。

三点约束：

1. 价格来源逐条标在 `priceSource` 上，一路传到 UI；`search` 的附来源链接让用户能自己点开核对。
2. agent 的 prompt 按来源区分口径：`search` 可以说"大约 480 元一晚"，`formula` 只能说档位，价格为 `null` 时必须说"未获取到价格"而不能编数字。
3. API 返回的价格字段以数据库为准，不用 agent 复述的——模型转述数字会出错。

即便是 `search` 也不是可下单报价：实际房费取决于日期、房型、会员等级。不要用任何一档做涉及支付的判断。

## ReAct

`src/lib/agent/react.ts`。没有手写 thought/action/observation 解析 —— AI SDK 的 multi-step tool calling 就是 ReAct 循环。这一层提供的是每步落库的执行轨迹（`agent_runs.steps`）、步数与超时上限、以及结构化输出。

结构化输出走**「提交答案」工具**而不是 JSON mode：openai-compatible provider 在设了 `experimental_output` 之后会给每一步都带上 `response_format: json_object`，而 DeepSeek 的 JSON 模式和 function calling 不能同时用，会让工具调用失效。`react.test.ts` 里有断言锁住这一点。

轨迹在 UI 上可以展开查看（"AI 推理过程"面板），也是排查"为什么把这两个远的地方排在同一天"的唯一依据。

## 数据库

PostGIS 是生产环境的首选，不是装饰：酒店的"位置合适"查询用 `ST_DWithin` + GiST 索引，在几万条 POI 上仍是毫秒级。`pg_trgm` 让用户输入"外滩"能匹配到"外滩风景区"（两种模式都需要）。

地理列的两种模式统一封装在 [geo.ts](src/lib/db/geo.ts) —— 上层查询用 `withinRadius()` / `distanceMeters()` / `geoSelect()`，不直接写 PostGIS 函数。新增涉及坐标的查询走这几个 helper，两种模式就都能用。

读取 `geography` 列时必须包 `ST_AsGeoJSON`（`geoSelect()` 会处理），否则 drizzle 的 customType 会收到 WKB 十六进制串，报一个跟地理列毫无关系的 JSON 解析错。

迁移文件开头手动加了两行 `CREATE EXTENSION` —— `docker/init` 只在数据卷首次创建时执行，对已有库或托管 Postgres 不生效。**重新生成迁移后要把这两行加回来。**

## 接口契约

前后端的约定集中在 [src/types/api.ts](src/types/api.ts) 一个文件里:路径、请求体、响应体各声明一次,两边都 import 它。

改接口时的顺序:

1. 改 `src/types/api.ts` 里对应的类型
2. `pnpm typecheck` —— 前端和后端两侧会同时报错,报错点就是要改的地方
3. 改完再跑一次,干净了说明两边对上了

几条约定:

- **路径不要在业务代码里拼字符串**,走 `API_ROUTES.xxx(tripId)`。后端换挂载点(比如加 `/v1` 前缀)只改这一个对象
- **响应统一包一层** `{ ok: true, data }` / `{ ok: false, error, kind? }`。前端 [client.ts](src/lib/client.ts) 负责拆包,业务代码拿到的直接是 `data`
- **后端返回值用 `okAs<T>()` 而不是 `ok()`**。`ok()` 的泛型是自由推导的,漏字段不报错;`okAs<GetTripData>()` 会在编译期拦住。实测:后端漏返回 `city` 时报 `Type '{...}' is missing the following properties from type 'Trip': city, status, ...`。16 个返回点已全部转成 `okAs`
- `okAs` 的参数类型是 `BeforeJson<T>`(见 [api.ts](src/lib/api.ts))。契约描述的是**前端收到的 JSON**,而路由手里是序列化之前的值 —— 差别主要在 `Date`:数据库给 `Date`,`JSON.stringify` 变成 ISO 字符串,所以契约写 `string`。`BeforeJson` 只在 `string` 位置额外允许 `Date`,漏字段和类型写错照样拦住

写读取用的类型时**别复用写入类型**。`ItemInput` 那种 `poiId?: string | null` 的可选是为了让调用方少写 null,但读出来的行每列都在。混用会让契约对不上:`undefined` 的键被 `JSON.stringify` 整个省掉,前端读到 `undefined`,而契约声明的是 `null`。
- **鉴权只有一个注入点**:`client.ts` 里的 `buildHeaders()`。要带 token 改这一个函数,13 个接口全都带上
- `ApiError` 带了 `status`,鉴权接入后 UI 能区分 401 和其它错误

`kind` 字段用来区分"程序出错"和"环境没配好" —— 后者 UI 显示的是配置步骤而不是红色报错框。新增 kind 记得同步 `SETUP_KINDS`。

## 测试

```bash
pnpm test
```

144 个测试，覆盖的是错误代价最高的部分：

- **调度器**（`schedule.test.ts`）：时刻累加、等开门、闭馆跳过、超时截断、时刻表单调性
- **求解编排**（`plan.test.ts`）：子矩阵下标映射、每点恰好一次、聚类分天、矩阵只算一次、API 失败降级
- **高德适配**（`amap.test.ts`）：`/distance` 的参数形状（多 origins 对单 destination，写反了会静默返回错误矩阵）、乱序结果按 `origin_id` 对齐、业务状态码
- **ReAct 循环**（`react.test.ts`）：提交后立即终止、多次提交取最后一次、步数耗尽的报错、轨迹写失败不影响主流程
- **价格链**（`price.test.ts`）：逐家降级只问上一级查不到的（不重复付费）、整级挂掉时完全落到下一级、方舟响应解析与引用去重、单位写错的值被挡掉、不同入住日期不共用缓存
- **酒店编排**（`amap-hotel.test.ts`）：星级过滤发生在查价之前（贵操作不为筛掉的店付钱）、查不到价仍返回、库里价格陈旧时才重查
- **PostGIS SQL**（`queries.test.ts`）：`ST_DWithin` 而非 `ST_Distance <`、部分唯一索引的 `ON CONFLICT` 谓词、参数绑定

没有覆盖真实的数据库和外部 API 调用，这两部分需要集成测试。

## 已知限制

- 没有鉴权。所有行程挂在一个固定的演示用户上，`ensureDemoUser()` 是接入 session 的替换点。
- 公交模式没有距离矩阵接口，用步行路网距离 × 经验系数近似。分天聚类够用，精确通勤在生成最终行程时对每段单独调路径规划。
- 营业时间只做粗粒度校验（取当天时段的最外层包络），午休这类中间断档由 agent 在文案里提示。
- 房价即便走联网查价也不是可下单报价，见上。真实可订价格需要接 OTA 接口（`PriceProvider` 的 `ota` 分支预留了位置）。
- 联网查价慢：一批 6 家十几秒，20 家酒店要一分钟左右。已经做了缓存和"只查会展示的那些"，但首次查询的等待是省不掉的。
