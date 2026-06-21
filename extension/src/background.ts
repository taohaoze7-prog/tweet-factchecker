// Background service worker：代理 content script 的网络请求。
// worker 的 fetch 不受页面（x.com）CSP 约束，用扩展自己的 host_permissions，
// 因此能打通 localhost:8000——这是绕过 X CSP 的标准 MV3 解法。
//
// 协议：content 通过 port("factcheck") 连进来 → 发 {type:"request", request}
//       → worker 流式 fetch /factcheck/stream，逐条回 {type:"event", event}
//       → 结束 {type:"end"}；出错 {type:"error", message}。

const BACKEND = "http://localhost:8000";

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "factcheck") return;

  const controller = new AbortController();
  port.onDisconnect.addListener(() => controller.abort());

  port.onMessage.addListener(async (msg: { type?: string; request?: unknown }) => {
    if (!msg || msg.type !== "request") return;
    try {
      const resp = await fetch(`${BACKEND}/factcheck/stream`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(msg.request),
        signal: controller.signal,
      });
      if (!resp.ok || !resp.body) {
        throw new Error(`stream failed: ${resp.status}`);
      }
      const reader = resp.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let sep: number;
        while ((sep = buf.indexOf("\n\n")) >= 0) {
          const rec = buf.slice(0, sep);
          buf = buf.slice(sep + 2);
          let data = "";
          for (const line of rec.split("\n")) {
            if (line.startsWith("data:")) data += line.slice(5).trim();
          }
          if (data) {
            try {
              port.postMessage({ type: "event", event: JSON.parse(data) });
            } catch {
              /* 跳过坏帧 */
            }
          }
        }
      }
      port.postMessage({ type: "end" });
    } catch (e) {
      port.postMessage({
        type: "error",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  });
});
