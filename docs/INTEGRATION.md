# 集成记录 — 三线合并回 main

Tweet FactChecker 采用 git worktree 三线并行开发，`main` 冻结契约 + 引擎骨架 + mocks，
三条线在各自 worktree 落地后合并回主干。本文件记录这次集成的范围与验证证据。

## 合并范围

| 线 | 分支 | 战场 | 合并提交 |
|----|------|------|----------|
| 1 号 frontend | `frontend` | `extension/`（MV3 + Vite + TS）抓推文→注入按钮→POST→浮层 | `ec9094e Merge branch 'frontend'` |
| 2 号 agent-layer | `agent-layer` | `backend/agents/` claim / evaluator / critic 真实 Claude agent | `ff36c01 Merge branch 'agent-layer'` |
| 3 号 engine-wiring | `engine-wiring` | `backend/wiring.py` 真实组装 | 已先期落入 main（`7cb6700`） |
| 4 号 监督/集成 | `main` | `create_app` 工厂 + `smoke.py` 双链路冒烟 | `6556dbf` |

冲突仅 `CLAUDE.md`（各线作业书 add/add）：main 改写为集成总览，各线作业书保留在各自分支。

## 契约一致性

`backend/contracts/models.py`（Pydantic）↔ `extension/src/types.ts`（TS 镜像）全程未改动，
前后端零漂移。

## 验证证据

### 后端（Python 3.12）

```
pytest        → 4 passed（契约单测 + mock 链路 HTTP 集成）
smoke.py mock → verdict=mostly_true conf=0.72 claims=2
```

### 浏览器端到端（扩展 → 真实 HTTP → 后端）

扩展 `USE_MOCK=false`，content script 打 `POST http://localhost:8000/factcheck`，
浮层渲染后端 mock orchestrator 结果：**可信分 72.0 / 基本属实 / 2 断言**（证明走真实 HTTP，
非前端静态 `mocks/response.json`）。

### 真实 Claude 链路

```
USE_REAL_AGENTS=1 smoke.py
real → verdict=true conf=0.99 claims=2
       models={claim: claude-haiku-4-5, evaluator: claude-sonnet-4-6, critic: claude-sonnet-4-6}
```

测试推文「地球是圆的。月球绕地球转。」走完
claim(haiku) → evaluator(sonnet + web_search 搜证) → critic(sonnet) 复核 → 聚合，
判定 `true / 0.99`，模型分层与契约约定一致。

### 扩展双链路（构建期 mock 开关）

`extension/src/api.ts` 用 `import.meta.env.VITE_USE_MOCK` 在构建期决定走向，
缺省打真后端，杜绝误把假数据发上线。两条链路均经浏览器点「核查」验收：

| 构建 | 产物 | 链路 | 浮层结果 |
|------|------|------|----------|
| `npm run build`（缺省）| 6.81 kB（mock JSON 被 tree-shake）| `POST localhost:8000/factcheck` 真后端 | 72.0 / 基本属实（mock orchestrator）；真实 agent 时 true / 0.99 |
| `VITE_USE_MOCK=true npm run build` | 8.13 kB（mock JSON 内联）| 离线 `mocks/response.json`，无需后端 | 35.2 / 大体不实 / 2 断言 / 3 证据 |

## 集成加固（合并后增量）

四线合并后，集成位（4 号）在 main 上补齐了闭环与延迟优化。均不改冻结契约。

### 容错降级（闭环最后一块）

engine-wiring 线代码未落地，集成位代补其 DoD：

- `core.safe_check_claim`：单条 claim 超时/异常一律降级为 `UNVERIFIABLE`，**绝不向上抛** →
  `orchestrator` 并行 `gather` 里任何单条失败不再 500 整条推文。
- `core.degraded_result`：降级带原因，可审计。
- `CLAIM_TIMEOUT_S`：初设 120s 太紧，真实两段式联网 evaluator（3 次串行 sonnet）会被误降级；
  实测诊断后调到 300s（超时只兜病态卡死）。
- 验证：新增「evaluator 抛错→整条降级不崩」单测；真链路恢复 `true / 0.99`。

### 延迟优化①：结果缓存

- `cache.CachingChecker` + `ResultCache`（带 TTL 的有界内存 LRU，键=规范化文本+语言），
  app 层包装，mock/real 通用，`CACHE_TTL_S` 可调（默认 1h）。
- 命中回填当前 `tweet_id` 与真实耗时（不可变更新），对判定质量零影响。
- 真链路实测：**冷启动 102.9s → 命中 1.0ms（≈10⁵×），结论一致**。
- 多 worker 部署需换共享缓存（Redis），已留 TODO。

### 延迟优化②：流式进度（SSE）

- `POST /factcheck/stream`：`claims 骨架 → claim×N（完成顺序）→ done 聚合`。
  `orchestrator.check_stream` 用 `as_completed` 边评边推；缓存命中直推单个 `done`。
- 前端 `stream.ts` 用 fetch + ReadableStream 自解析 SSE（EventSource 仅 GET，推文走 POST）；
  `ProgressOverlay` 骨架→逐条填判定→done 换规范最终卡片。
- 总时长不变，降的是**感知延迟**：冷启动不再干等。
- 验证：真 HTTP（Node fetch，与扩展同解析逻辑）跑出 `claims → claim → claim → done`。

---

## 总验收（一页）

> 截至 `745a19c`。Python 3.12 钉死；契约（`contracts/models.py` ↔ `types.ts`）全程冻结未漂移。

### 状态总账

| 阶段 | 状态 | 关键证据 |
|------|------|----------|
| 契约冻结 + 引擎骨架 + mocks | ✅ | 双链路 `smoke.py`、`create_app` 工厂 |
| 四线并行集成（front/agent/engine/main） | ✅ | `ec9094e`/`ff36c01`/`7cb6700`/`6556dbf`，仅 `CLAUDE.md` add/add 冲突，已解 |
| 真实 Claude 链路 | ✅ | `real → true / 0.99`，模型分层 haiku+sonnet×2 |
| 容错闭环 | ✅ | 单条失败降级不 500；抛错单测 |
| 上线安全（mock 开关） | ✅ | `VITE_USE_MOCK` 构建期注入，缺省真后端 |
| 延迟优化（缓存 + 流式） | ✅ | 重复 1ms；冷启动渐进渲染 |
| 测试 | ✅ | `pytest` **9 passed**；`tsc` 干净；双链路冒烟全过 |

### 延迟画像

| 场景 | 延迟 | 手段 |
|------|------|------|
| 重复推文 | ~1ms | 结果缓存 |
| 冷启动 | 总时长 ~103s（不变），但**渐进渲染**无干等 | 流式进度 |

### 遗留决策项（非阻塞）

1. **冷启动总时长 ~103s**：再压需碰 agent 判定质量（降 `effort` / 改 evaluator 两段式）——
   属 agent-layer/产品层权衡，待拍板。安全延迟优化已到顶。
2. **多 worker 缓存**：现为进程内内存缓存，多实例部署需换 Redis（`cache.py` 已留 TODO）。
3. **engine-wiring 分支**：其 DoD 由集成位在 main 代补，分支本身停在作业书，可归档。

---

## 数据驱动的筛选/过滤复盘（真链路采样后定）

对核查管道「筛选 + 过滤」标准做了一轮真链路采样，结论与处置：

### 已做

- **结论透明化（已落 `8816cac`）**：`aggregate` 的 summary 明说覆盖率（共 N 条 / M 条已核实 /
  K 条无法核实），整体判定仍只基于已核实断言。
- **证据溯源观测（A，本次）**：`evaluator._gather` 现额外收集 `web_search_tool_result` 的真实
  检索 URL；`evaluate` 对每条证据 URL 做精确+域名级溯源，**不在检索集里只告警不丢弃**
  （`logger.warning`）。实测幻觉率 0%（10/10 精确命中），故只留观测口，不做拦截。

### 数据驱动否决（不做）

- **③ 严格 URL 过滤器**：实测幻觉率 0% → 严格丢弃零收益且有误杀风险，降级为上面的「仅告警」。
- **② 聚合二次加权**：confidence 已折进证据强度，二次加权收益不明、易引偏差。
- **④ 权威白名单**：高维护、易过时；交叉验证 + critic 已部分覆盖。

### 超时值（⑤）

- **canonical = 300s**。单条 `evaluate` 实测 48–63s，加 critic ≈ 65–90s，限流重试可达 120–150s；
  150s 余量太薄会误降级真结论。`main` 已是 300s（代码+文档自洽）。
- ⚠️ **协调项**：`ui-upgrade` 分支把 `CLAIM_TIMEOUT_S` 收紧到了 150s，需对齐回 300s。

### 跨分支 bug 记录（main 无需改）

- 采样发现 `_structure` 偶发假阴性（真断言被判 UNVERIFIABLE，失败率约 50%）：根因是模型把
  `evidence` 数组 double-encode 成 JSON 字符串，旧 `extract_structured` 的 `model_validate` 噎住。
- **该 bug 只在 `ui-upgrade`（仍用 `extract_structured`）**。`main` 已迁官方
  `parse_structured`（`messages.parse` + `output_format`，服务端强制 schema），实测 3/3 稳定，
  结构上已消除此 bug。
- ⚠️ **协调项**：`ui-upgrade` 应跟随 main 迁 `parse_structured`，或在 `extract_structured`
  校验前加 JSON-string 还原。

## 复现

见根目录 [`CLAUDE.md`](../CLAUDE.md) 的「本地端到端」。
