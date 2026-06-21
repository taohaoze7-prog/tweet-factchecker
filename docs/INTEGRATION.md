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

## 复现

见根目录 [`CLAUDE.md`](../CLAUDE.md) 的「本地端到端」。
