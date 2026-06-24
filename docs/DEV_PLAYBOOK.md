# 开发实战手册

> 在真 X 上跑通这个扩展踩出来的坑，固化在此。架构看 [CLAUDE.md](../CLAUDE.md)，
> 这里只讲**怎么跑、怎么调、报错怎么办**。

## 一、快速跑起来

```bash
# 1. 后端（真实 Claude）
cd backend
USE_REAL_AGENTS=1 ANTHROPIC_API_KEY=sk-ant-... ./.venv/bin/uvicorn app:app --port 8000
#    看到 "Application startup complete." 且无 ERROR 即成

# 2. 扩展构建（默认打真后端）
cd extension && npm run build
#    产物 dist/ = content.js + background.js + manifest.json + icons/，可直接加载

# 3. 加载到 Chromium（Atlas / Chrome 均可）
#    chrome://extensions → 开发者模式 → 加载已解压的扩展程序 → 选 extension/dist

# 4. 打开 x.com → 推文动作栏出现「✓ 核查」→ 点它
```

## 二、🚨 开发铁律（最常踩）

**每次改了扩展代码并重新 `npm run build` 之后，必须做两件事：**

1. `chrome://extensions` → 找到 Tweet FactChecker → 点 **⟳ 重新加载**
2. 切到 x.com 标签页 → **`Cmd + Shift + R` 硬刷新**

**漏了第 1 步** → 浏览器还跑旧包（比如改了还显示老结果）。
**漏了第 2 步** → 页面里残留的旧 content script 失联 → 报 `Extension context invalidated`。

> Chrome 扩展**不会**因为 dist 文件变了就自动更新，content script 也不会自动重注入。

## 三、mock vs real 构建

| 命令 | 走向 | 用途 |
|------|------|------|
| `npm run build` | 真后端 `localhost:8000` | 默认；上线/真测 |
| `VITE_USE_MOCK=true npm run build` | 本地 `mocks/response.json` 假数据 | 离线开发，不用起后端 |

启动时 **F12 Console** 会打印当前模式，一眼确认装对没：
```
[factchecker] content script 已加载 · 模式=REAL→http://localhost:8000 · 开始监听
```
显示 `模式=MOCK` 但你以为该 REAL → 没 reload，回铁律第 1 步。

> 沙盒 `extension/design/sandbox.html`：用假 X DOM + 真 content.js（mock 构建）验证渲染，不用起后端、不用上真 X。

## 四、报错速查

| 现象 | 原因 | 解决 |
|------|------|------|
| `Failed to fetch` | 后端没起 **或** 被 CSP 拦 | `curl localhost:8000/health` 验后端；好的话就是 CSP，确认网络走 background worker（已实现） |
| `Extension context invalidated` | 重载扩展后没刷页面 | x.com `Cmd+Shift+R`（见铁律） |
| `[Errno 48] address already in use` | 旧 uvicorn 还占着 8000 | `lsof -ti:8000 \| xargs kill -9` 再起 |
| 所有推文都显示同一张卡（失业率） | 装的是 **mock 构建** | `npm run build`（真后端）+ reload + 硬刷新 |
| 卡片浮在推文右侧 | 旧版挂载点问题 | 已修（挂到 article 之后的兄弟节点）；确保是最新构建 |
| 简单评论（"Great"）扫很久 | 旧版兜底把非断言当 checkable | 已修（无可核查断言秒回）；确保后端是最新代码并**重启了 uvicorn** |

> ⚠️ 后端用 `uvicorn` 起的（没带 `--reload`），**改了后端代码必须 Ctrl+C 重启**才生效。

## 五、为什么网络走 background worker

X 的页面 CSP 会拦 content script 直接 `fetch localhost:8000`（→ `Failed to fetch`）。
**background service worker 的 fetch 用扩展自己的 `host_permissions`，不受页面 CSP 约束**——
所以所有网络（核查流 + 反馈）都经 worker 中继：

```
content script ──port/onMessage──> background worker ──fetch──> localhost:8000
```

调 worker 的报错：`chrome://extensions` → Tweet FactChecker → 点 **Service Worker** 链接，
那是 worker 的独立 Console（比页面 Console 更准地反映 fetch 真实失败）。

## 六、性能预期

| 场景 | 延迟 |
|------|------|
| 非事实内容（问候/表态/"Great"） | ~1–2s（无可核查断言，秒回） |
| 有事实主张的推文（冷启动） | ~80–100s（3 次 sonnet + 联网，串行）；流式骨架 + 实时秒表可见进度 |
| 重复同一推文 | ~1ms（结果缓存） |

单条断言超时 150s 即降级为「无法核实」，不拖垮整条。

## 七、反馈数据

卡片底部 👍/👎 → 经 worker → `POST /feedback` → 追加 `backend/data/feedback.jsonl`（gitignored）。
每行：`推文原文 + 我们的裁决 + 置信度 + 用户 up/down + 模型 + 时间戳`。
攒够后用作 eval 集 / 调提示词 / 来源权重——这是本项目的"学习"路径（不用 RL）。

```bash
cat backend/data/feedback.jsonl | tail   # 随时看
```
