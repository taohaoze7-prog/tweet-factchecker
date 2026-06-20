# CLAUDE.md — engine-wiring worktree（3 号线）

战场：`backend/`（`orchestrator.py` / `core.py` / `wiring.py` / `app.py`）。把真实 agent 串成可运行链路。

## 🚫 铁律（最高优先级）

**契约冻结。不许私改 `backend/contracts/models.py` 的形状。**
要改 → 回 `main` 过一道、三线同步后再动。这是唯一会让三个 worktree 互相打架的地方。

## 启动

```bash
cd backend
python3.12 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
pytest                                       # 改动后必跑
USE_REAL_AGENTS=1 ANTHROPIC_API_KEY=sk-ant-... uvicorn app:app --reload   # 切真实链路
```

> 接线骨架已就位：`wiring.build_real_orchestrator()` 已把三真实 agent 装进 `Orchestrator`，
> `app.get_orchestrator()` 用 `USE_REAL_AGENTS` 开关切 mock/真实。基础接缝**已绿**。

## ✅ Definition of Done（做完算什么）

- [ ] **容错**：单条 claim 评估失败（超时 / API 报错 / NotImplementedError）不拖垮整条推文 —— 降级为该 claim `UNVERIFIABLE` 并记错，其余照常
- [ ] 给 `orchestrator.check` 的并行评估加超时与异常隔离（`asyncio.gather` 的 `return_exceptions` 或逐个 wrap）
- [ ] `model_versions` 在真实路径正确写入（已由 `wiring.py` 带出，验证端到端透传到响应）
- [ ] **mock 路径保持可用**：`USE_REAL_AGENTS` 未设时仍跑 mock，`pytest` 全绿
- [ ] 端到端：真实 key 下 `POST /factcheck` 返回合规 `FactCheckResult`（即便部分 claim 降级）
- [ ] 合并回 `main` 前：mock 与真实两条路径都自测过

## 集成约定（4 号位）

agent 方法体由 agent-layer 落地——在他们填实前，真实路径会在 agent 内部抛 `NotImplementedError`，
正好用来验证你的**容错降级**逻辑。契约变更一律走 `main`。
