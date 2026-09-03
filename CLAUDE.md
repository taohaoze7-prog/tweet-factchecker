# CLAUDE.md — Tweet FactChecker

X/Twitter 推文一键事实核查：抓推文 → 三段 agent 管道核查 → 卡片展示带来源的结论。

## 架构（v0.2 — 无后端）

**v0.1 是「扩展 + FastAPI 后端」。v0.2 把管道整个搬进了扩展。**
改动动因：产品定为「用户自带 API Key」，若仍走后端，用户的密钥要经过开发者服务器
——那是商店审核的高风险项，也是不必要的责任。现在密钥不出用户浏览器。

```
extension/  (TypeScript + Vite + MV3)
  content.ts    抓推文 + 注入「核查」按钮 + 驱动卡片
  overlay.ts    FactCard —— Shadow DOM 隔离 + 环形仪表 + 流式动效
  api.ts        连 background port，把事件流转成 async generator
  background.ts service worker：核查管道的执行者
  settings.ts   API Key 读写（chrome.storage.local）
  options.ts    设置页逻辑（验证 + 保存 + 清除）
  engine/       ← 管道本体（从 backend/ 移植）
    anthropic.ts  直连 api.anthropic.com 的 fetch 封装
    structured.ts 强制工具调用 → 结构化输出 + 类型闸门
    claim.ts      抽断言        (Haiku 4.5)
    evaluator.ts  联网搜证初判  (Sonnet 5 + web_search)
    critic.ts     独立复核      (Sonnet 5)
    pipeline.ts   收敛 + 聚合 + 流式编排
```

管道：`推文 → claim 抽断言 → evaluator 搜证初判 → critic 复核 → 聚合`

**为什么管道必须跑在 background 而非 content script**：X 的 CSP 会拦掉页面内脚本的
跨域 fetch。service worker 用扩展权限，不受页面 CSP 约束。

**为什么能从浏览器直连 Anthropic**：带 `anthropic-dangerous-direct-browser-access: true`
头即可（已实测 CORS 放行）。在扩展里这是安全的——key 存用户本机，不经第三方。

## 🚫 铁律

1. **证据必须可追溯**：`source_url` 过 `isRealUrl` 闸门（http(s) + 带点主机名）。
   点不开的「来源」比没有来源更糟——它在卡片上和真链接一样权威。
   渲染层 `overlay.ts` 还有第二道协议闸门，防 `javascript:` 伪协议 XSS
   （推文内容能影响模型输出，这是一条真实的注入链）。
   **配套两条**：
   - 搜证阶段必须用 `searchResultsOf()` 把 `web_search_tool_result` 里的真实 URL
     显式喂给结构化阶段。只读 `textOf()` 会漏——模型散文常写「据 NASA 官网」而不带链接，
     下游便无 URL 可引，证据被闸门清空。这是实测踩到的坑，别退回去。
   - 证据过闸门后若为空，判定强制降级 `unverifiable`。绝不允许「零证据却挂 false」。
2. **不确定就说不确定**：证据不足判 `unverifiable`；多条断言只核实一部分时，
   `aggregate()` 必须在 summary 里写明覆盖率，不让整体判定掩盖未核实的部分。
3. **模型输出一律过闸门**：`structured.ts` 的 `asString/asEnum/clamp01` 是唯一入口，
   没校验过的模型输出不许进契约对象。
4. **省用户的钱**：用户自付费。关卡片 → port 断开 → worker abort → 掐断在途调用。
   非断言（"Great!!"）绝不进搜证管道。

## 本地开发

```bash
cd extension
npm install
npm run build                      # → dist/，Chrome「加载已解压」
VITE_USE_MOCK=true npm run build   # 离线假数据，不花钱、开 DEBUG 日志
npm run package                    # → factchecker-0.2.0.zip（上架用）

# 引擎冒烟（真实 API，会花钱，约 $0.3/次）
ANTHROPIC_API_KEY=sk-ant-... npx tsx scripts/smoke.ts
```

**改完扩展必须**：`chrome://extensions` ⟳ 重载 + x.com `Cmd+Shift+R` 硬刷新。
否则报 "Extension context invalidated" 或还跑旧包。

## 上架

材料与检查清单见 `docs/STORE_LISTING.md`，隐私政策 `docs/privacy.html`
（经 GitHub Pages 发布，商店审核会实际访问）。

## backend/ 的现状

**已不被扩展使用**，作为参考实现保留（Python 版管道 + 契约 + 测试）。
`extension/src/engine/` 是它的 TypeScript 移植，逻辑一一对应。
若要改核查逻辑，改 `engine/`；`backend/` 不会被构建或分发。
