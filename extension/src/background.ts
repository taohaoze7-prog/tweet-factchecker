// Background service worker：核查管道的执行者。
//
// 架构变更（v0.2）：管道从 Python 后端整个搬进了这里。
// 以前 worker 只是代理 → localhost:8000；现在它直接跑 claim/evaluator/critic
// 三段管道，用用户自己的 Key 调 api.anthropic.com。没有后端，没有中转，
// Key 不离开这台设备。
//
// worker 的 fetch 不受页面（x.com）CSP 约束——这仍是必须走 worker 而非
// content script 直连的原因。
//
// 协议：content 通过 port("factcheck") 连进来 → 发 {type:"request", request}
//       → worker 逐条回 {type:"event", event} → 结束 {type:"end"}
//       → 出错 {type:"error", message, kind}。

import { AnthropicError } from "./engine/anthropic";
import { checkStream } from "./engine/pipeline";
import { getApiKey } from "./settings";
import type { FactCheckRequest } from "./types";

/** 把内部错误翻译成用户读得懂、且知道下一步做什么的话。*/
function describe(e: unknown): { message: string; kind: string } {
  if (e instanceof AnthropicError) {
    return { message: e.message, kind: e.kind };
  }
  if (e instanceof Error) {
    return { message: e.message, kind: "unknown" };
  }
  return { message: String(e), kind: "unknown" };
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "factcheck") return;

  const controller = new AbortController();
  let closed = false;
  port.onDisconnect.addListener(() => {
    closed = true;
    // 用户关掉卡片 / 离开页面 → 掐断在途请求。
    // 这条直接省钱：不中止的话，剩余的 Sonnet 调用会继续烧用户额度。
    controller.abort();
  });

  port.onMessage.addListener(async (msg: { type?: string; request?: FactCheckRequest }) => {
    if (!msg || msg.type !== "request" || !msg.request) return;

    // MV3 的 service worker 闲置 30s 即被回收。一次核查要 100~200s，而联网搜证
    // 那段可能几十秒不产生任何事件——worker 被杀 → port 断开 → 核查静默流产。
    // 定期发心跳，既重置闲置计时器，也让前端能显示"仍在进行"。
    const heartbeat = setInterval(() => {
      if (closed) return;
      try {
        port.postMessage({ type: "ping" });
      } catch {
        /* port 已断，下一轮由 closed 拦住 */
      }
    }, 20_000);

    try {
      const apiKey = await getApiKey();
      if (!apiKey) {
        // 不是错误，是尚未配置——给一条能直接点进设置页的提示。
        throw new AnthropicError(
          "no_key",
          "尚未配置 Anthropic API Key，请在扩展设置中填入后再试。",
        );
      }

      for await (const event of checkStream(apiKey, msg.request, controller.signal)) {
        if (closed) return; // 端口已断，不再 postMessage（否则抛异常）
        port.postMessage({ type: "event", event });
      }
      if (!closed) port.postMessage({ type: "end" });
    } catch (e) {
      // 主动取消不算错误，静默收场。
      if (controller.signal.aborted) return;
      if (closed) return;
      const { message, kind } = describe(e);
      port.postMessage({ type: "error", message, kind });
    } finally {
      clearInterval(heartbeat);
    }
  });
});

// content script 无权直接开设置页，代它转一手。
chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === "open_options") void chrome.runtime.openOptionsPage();
});

// 首次安装打开设置页——没有 Key 的话扩展做不了任何事，
// 与其让用户点了核查才看到报错，不如装完就引导配置。
chrome.runtime.onInstalled.addListener(async (details) => {
  if (details.reason !== "install") return;
  if (!(await getApiKey())) {
    void chrome.runtime.openOptionsPage();
  }
});

// 点工具栏图标 → 打开设置页（扩展没有 popup，图标唯一的用途就是进设置）。
chrome.action.onClicked.addListener(() => {
  void chrome.runtime.openOptionsPage();
});
