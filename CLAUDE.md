# CLAUDE.md — Tweet FactChecker（集成主干 / main）

X/Twitter 推文一键事实核查：浏览器扩展抓推文 → 后端多 agent 管道核查 → 浮层展示结论。

> 三条 worktree（frontend / agent-layer / engine-wiring）已合并回 `main`。
> 各线的作业书保留在各自分支；本文件是集成主干的总览。

## 架构

```
extension/  (TypeScript + Vite + MV3)        ← 1 号线 frontend
  抓推文 → 注入「核查」按钮 → POST /factcheck → 浮层渲染结论
        │
        ▼
backend/   (FastAPI + Python 3.12)
  contracts/   共享数据契约（Pydantic）—— 冻结，与 extension/src/types.ts 镜像
  agents/      claim / evaluator / critic   ← 2 号线 agent-layer（真实 Claude agent）
  core.py      单断言收敛 + 聚合
  orchestrator.py  串 claim→evaluator→critic
  wiring.py    真实 agent 组装（USE_REAL_AGENTS=1）← 3 号线 engine-wiring
  mocks/       固定数据 mock，零 key 联调
  app.py       create_app(orchestrator) 工厂 + HTTP 入口
  smoke.py     双链路集成冒烟（mock 硬门槛 + real 可选）
```

核查管道：`推文 → ClaimAgent 抽断言 → EvaluatorAgent 搜证初判 → CriticAgent 复核 → 聚合`
模型分层：claim=`claude-haiku-4-5`，evaluator/critic=`claude-sonnet-4-6`。

## 🚫 铁律

**契约冻结**：`backend/contracts/models.py` 与 `extension/src/types.ts` 的形状一一对应，
改动必须两侧同步——这是前后端唯一会漂移打架的地方。

## 本地端到端

```bash
# 后端（默认全 mock，无需 key）
cd backend
python3.12 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
pytest                                                # 契约单测 + mock 链路 HTTP 集成
python smoke.py                                       # 集成冒烟（mock）
uvicorn app:app --reload                              # http://localhost:8000/factcheck

# 接真实 Claude 链路
USE_REAL_AGENTS=1 ANTHROPIC_API_KEY=sk-ant-... uvicorn app:app --reload

# 前端
cd ../extension
npm install
npm run build                                         # 产物 dist/ → Chrome 加载已解压扩展
```

扩展默认 `USE_MOCK=false`（`extension/src/api.ts`），直接打 `http://localhost:8000/factcheck`；
无后端时把 `USE_MOCK` 置 `true`，用 `extension/mocks/response.json` 离线渲染。
