# Tweet FactChecker

X/Twitter 推文一键事实核查：浏览器扩展抓推文 → 后端多 agent 管道核查 → 浮层展示结论。

## 架构

```
extension/  (TypeScript + Vite + MV3)        ← 1号 worktree: frontend
  抓推文 → 注入"核查"按钮 → 浮层显示结论
        │  POST /factcheck  （契约见 backend/contracts ↔ extension/src/types.ts）
        ▼
backend/   (FastAPI + Python)
  contracts/   共享数据契约（Pydantic）——三线命脉，已冻结
  agents/      claim / evaluator / critic   ← 2号 worktree: agent-layer
  core.py      单断言管道 + 结果收敛
  orchestrator.py  串 claim→evaluator→critic ← 3号 worktree: engine-wiring
  mocks/       固定数据 mock，全线联调用
  app.py       HTTP 入口（默认挂 mock 编排器）
```

核查管道：`推文 → ClaimAgent 抽断言 → EvaluatorAgent 搜证初判 → CriticAgent 复核 → 聚合`

模型分层：claim=`claude-haiku-4-5`，evaluator/critic=`claude-sonnet-4-6`。

## 并行开发（git worktree）

`main` 已冻结 contracts + engine 骨架 + mocks。三条线在 worktree 上并行：

```bash
git worktree add ../factchecker-frontend     -b frontend       # extension/
git worktree add ../factchecker-agent-layer  -b agent-layer    # backend/agents/
git worktree add ../factchecker-engine-wiring -b engine-wiring  # backend/orchestrator + core
# 第4个终端留在 main，做监督 / 集成
```

各线均依赖 `backend/contracts`（Python）/ `extension/src/types.ts`（TS）的冻结契约。

## 本地运行（全 mock，无需 API key）

```bash
cd backend
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
uvicorn app:app --reload          # http://localhost:8000/factcheck
pytest                            # 契约 + 管道冒烟测试

cd ../extension
npm install
npm run build                     # 产物 dist/ → Chrome 加载已解压扩展
```

接入真实 Claude agent：`export USE_REAL_AGENTS=1`（待 engine-wiring 落地组装）。
