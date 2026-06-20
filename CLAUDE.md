# CLAUDE.md — frontend worktree（1 号线）

战场：`extension/`（TypeScript + Vite + MV3）。抓推文 → 注入「核查」按钮 → 浮层显示结论。

## 🚫 铁律（最高优先级）

**契约冻结。不许私改 `extension/src/types.ts` 与后端 `backend/contracts/models.py` 的形状。**
要改 → 回 `main` 过一道、三线同步后再动。这是唯一会让三个 worktree 互相打架的地方。

## 启动

```bash
# 起 mock 后端（另开一个 shell，3.12）
cd ../factchecker-frontend/backend     # 或任一 worktree 的 backend
python3.12 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
uvicorn app:app --reload               # http://localhost:8000，默认全 mock，无需 key

# 起前端
cd ../extension
npm install
npm run build                          # 产物 dist/ → Chrome「加载已解压的扩展程序」
npm run typecheck                      # 改动后必跑
```

## ✅ Definition of Done（做完算什么）

- [ ] `content.ts` 真实从 X/Twitter 的 `article` 结构抽取 `tweet_id / text / author_handle / url`（不是 `innerText` 兜底）
- [ ] 按钮注入在时间线动态加载下**不重复、不漏**（`MutationObserver` 稳定）
- [ ] `overlay.ts` 正式浮层 UI：按 `Verdict` 配色，展示 `summary` + 每条 `ClaimResult` 的 `final_verdict` + 证据链接
- [ ] 全程只 `import` `src/types.ts`，不碰后端契约定义
- [ ] `npm run typecheck` 通过；对 mock 后端能完整跑通「点按钮 → 浮层出结论」
- [ ] 合并回 `main` 前：自测过上面这条端到端链路

## 集成约定（4 号位）

契约变更一律走 `main`。合并前确保 `npm run build` 绿、对 mock 后端联调通过。
