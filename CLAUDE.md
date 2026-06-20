# CLAUDE.md — agent-layer worktree（2 号线）

战场：`backend/agents/`。实现 claim / evaluator / critic 三个真实 Claude agent。

## 🚫 铁律（最高优先级）

**契约冻结。不许私改 `backend/contracts/models.py` 与 `backend/agents/base.py` 的签名/形状。**
要改 → 回 `main` 过一道、三线同步后再动。这是唯一会让三个 worktree 互相打架的地方。

## 启动

```bash
cd backend
python3.12 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
export ANTHROPIC_API_KEY=sk-ant-...     # 真实 agent 需要
pytest                                  # 改动后必跑（mock 路径不能被你弄红）
```

模型已在各文件钉好：claim=`claude-haiku-4-5`，evaluator/critic=`claude-sonnet-4-6`。
SDK 用官方 `anthropic`（异步），封装见 `llm/client.py`。

## ✅ Definition of Done（做完算什么）

- [ ] 三个 `NotImplementedError` 全部实现：`ClaudeClaimAgent.extract` / `ClaudeEvaluatorAgent.evaluate` / `ClaudeCriticAgent.critique`
- [ ] 用 **structured outputs**（`messages.parse` + Pydantic 契约对象）返回结果，**不手撸 JSON 字符串匹配**
- [ ] `evaluator` 每条 `Evidence` 必带 `source_url`；联网搜证用 `web_search` 工具
- [ ] `critic` 不认可时必给 `adjusted_verdict` + `concerns`；认可时 `concerns` 可空
- [ ] 三个 agent 都满足 `agents/base.py` 的 Protocol（`isinstance(x, ClaimAgent)` 通过 / orchestrator 可直接注入）
- [ ] 各 agent 有单测（对 Claude 调用打桩），且**不破坏 `mocks/` 路径**与现有 `pytest`
- [ ] 合并回 `main` 前：`USE_REAL_AGENTS=1 uvicorn app:app` 能对一条真实推文返回合规 `FactCheckResult`

## 集成约定（4 号位）

`wiring.py` 已把你的三个 agent 接好（engine-wiring 交付）——你只管把方法体填实，接线不用碰。
契约变更一律走 `main`。
