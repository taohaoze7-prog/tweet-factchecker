# Tweet FactChecker

在 X/Twitter 的每条推文旁加一个「核查」按钮。点一下，联网搜证、独立复核，给出带来源链接的结论。

**没有服务器。** 核查管道整个跑在浏览器扩展里，用你自己的 Anthropic API Key
直连 `api.anthropic.com`。密钥存在本机，不经过任何第三方。

---

## 它怎么工作

```
推文
 └─ 抽取断言      Haiku 4.5     拆成可独立验证的事实性陈述，跳过观点与情绪
     └─ 联网搜证   Sonnet 5      为每条断言检索权威来源，交叉验证
         └─ 独立复核 Sonnet 5    以「魔鬼代言人」身份审查初判，挑证据缺口与逻辑跳步
             └─ 聚合            按置信度加权，给出整体判定
```

结论分六档：属实 / 基本属实 / 真假参半 / 大体不实 / 不实 / 无法核实。

## 设计原则

**可追溯优先。** 每条证据必须带可点开的来源链接。模型偶尔会吐出相对路径、裸域名或
占位文字——这类「来源」在卡片上和真链接一样权威却无法核验，比没有来源更糟，
因此会被直接丢弃。若过滤后证据为空，判定强制降级为「无法核实」，绝不出现
「零证据却挂着确定结论」。

**不确定就说不确定。** 多条断言中只核实了一部分时，结论里会写明覆盖率
（「共 3 条断言，1 条已核实……另有 2 条无法核实，未计入整体判定」），
不让头部判定掩盖未核实的部分。

**无服务器。** 开发者不运营任何后端，看不到你核查了什么。这也是隐私政策
能写成「不收集任何数据」的前提。

## 安装

### 从源码构建

```bash
cd extension
npm install
npm run build          # 产物在 dist/
```

Chrome → `chrome://extensions` → 打开开发者模式 → 「加载未打包的扩展程序」→ 选 `dist/`。

首次安装会打开设置页，填入 Anthropic API Key
（在 [console.anthropic.com](https://console.anthropic.com/settings/keys) 创建）。

## 费用

扩展免费。模型调用按 Anthropic 官方价目从**你自己的账户**扣除，
开发者不经手也不抽成。

典型单次核查约 **$0.10–0.35**，取决于推文里断言的条数：
一次 Haiku（抽断言）＋ 每条断言两次 Sonnet（搜证 + 复核）＋ 联网搜索。

## 已知限制

**单次核查约 150 秒。** 管道结构决定的：每条断言都要联网搜证再复核，且各条并行。
卡片有流式骨架和实时秒表来缓解等待感，但这仍是硬伤。

**自动核查会出错。** 模型可能误读断言、检索到不可靠来源，或对时效性极强的事件
给出过时结论。请把结论当作「带来源的调查起点」，而不是最终裁决——
每条证据的链接都可点开，请自行判断。

**界面仅中文。**

## 隐私

密钥与反馈标记存在 `chrome.storage.local`（本机，不同步）。
你主动点击核查的推文文本会发往 Anthropic 用于核查；除此之外不收集、不上传、
不存储任何数据，没有分析埋点。

完整说明见[隐私政策](https://taohaoze7-prog.github.io/tweet-factchecker/privacy.html)。

## 开发

```
extension/src/
  content.ts     抓推文 + 注入按钮
  overlay.ts     核查卡渲染（Shadow DOM 隔离，不污染 X 的样式）
  background.ts  service worker：核查管道的执行者
  engine/        管道本体
    anthropic.ts   直连 API 的 fetch 封装 + 错误分类
    structured.ts  强制工具调用 → 结构化输出 + 类型闸门
    claim.ts / evaluator.ts / critic.ts
    pipeline.ts    收敛 + 聚合 + 流式编排
```

```bash
npm run typecheck
VITE_USE_MOCK=true npm run build                        # 离线假数据，不花钱
ANTHROPIC_API_KEY=sk-ant-... npx tsx scripts/smoke.ts   # 真链路冒烟（约 $0.3）
npm run package                                         # 上架 zip
```

改动扩展后需在 `chrome://extensions` 点重载，并在 x.com 硬刷新（`Cmd+Shift+R`），
否则页面仍在跑旧包。

`backend/` 是 v0.1 的 Python 参考实现，已不被构建或分发；
`extension/src/engine/` 是它的 TypeScript 移植。改核查逻辑改后者。
