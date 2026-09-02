// content script 侧的核查入口。
//
// 架构变更（v0.2）：不再有后端。核查管道跑在 background service worker 里，
// 本模块只负责「连上 worker、把事件流转成 async generator」。
// 之所以仍要经 worker：X 的 CSP 会拦掉 content script 直接发起的跨域 fetch，
// worker 用扩展权限则不受页面 CSP 约束。
//
// 离线调试用 `VITE_USE_MOCK=true npm run build` 走 mocks/response.json，
// 上线构建不带该 env → 自动走真链路，杜绝"忘改 const 把假数据发上线"。

import type { FactCheckRequest, FactCheckResult, Verdict } from "./types";
import { type StreamEvent } from "./stream";
import mockResponse from "../mocks/response.json";

// 构建期开关（Vite 静态注入）。
const USE_MOCK = import.meta.env.VITE_USE_MOCK === "true";
export const IS_MOCK = USE_MOCK;

const MOCK_LATENCY_MS = 600;

/** 带类型的核查错误——kind 让 UI 能给出「下一步做什么」而不只是报错文本。*/
export class FactCheckError extends Error {
  constructor(
    message: string,
    readonly kind: string = "unknown",
  ) {
    super(message);
    this.name = "FactCheckError";
  }
}

/** 真实链路：连 worker，把 port 消息转成事件流。*/
async function* factCheckStreamReal(
  req: FactCheckRequest,
): AsyncGenerator<StreamEvent> {
  // 扩展重载后旧页面的 content script 会失联（chrome.runtime.id 变 undefined）。
  // 给可操作提示，而非抛原始的 "Extension context invalidated"。
  if (!chrome.runtime?.id) {
    throw new FactCheckError("扩展已更新，请刷新本页面（Cmd+Shift+R）后重试", "stale");
  }

  const port = chrome.runtime.connect({ name: "factcheck" });
  const queue: StreamEvent[] = [];
  let wake: (() => void) | null = null;
  let finished = false;
  let completed = false; // 是否收到过 end/error —— 用于区分"正常收尾"与"半路断线"
  let failure: FactCheckError | null = null;

  const pump = (): void => {
    wake?.();
    wake = null;
  };

  port.onMessage.addListener(
    (msg: { type: string; event?: StreamEvent; message?: string; kind?: string }) => {
      if (msg.type === "event" && msg.event) queue.push(msg.event);
      else if (msg.type === "ping") return; // 心跳，仅用于保活，不入队
      else if (msg.type === "end") {
        finished = true;
        completed = true;
      } else if (msg.type === "error") {
        failure = new FactCheckError(msg.message ?? "未知错误", msg.kind ?? "unknown");
        finished = true;
        completed = true;
      }
      pump();
    },
  );
  port.onDisconnect.addListener(() => {
    // 没收到 end 就断开 = worker 被回收或崩溃。必须报错，
    // 否则调用方会把"什么都没拿到"当成核查成功，按钮显示已核查却没有卡片。
    if (!completed) {
      failure = new FactCheckError(
        "核查意外中断（后台进程被浏览器回收），请重试",
        "worker_gone",
      );
    }
    finished = true;
    pump();
  });

  port.postMessage({ type: "request", request: req });

  try {
    for (;;) {
      while (queue.length) yield queue.shift() as StreamEvent;
      if (failure) throw failure;
      if (finished) return;
      await new Promise<void>((r) => (wake = r));
    }
  } finally {
    // 关闭 port 会触发 worker 侧 abort，掐掉在途的模型调用——直接省用户的钱。
    port.disconnect();
  }
}

/** Mock 流式：从固定假数据合成 claims → claim×N → done 事件序列。*/
async function* factCheckStreamMock(
  req: FactCheckRequest,
): AsyncGenerator<StreamEvent> {
  const result: FactCheckResult = {
    ...(mockResponse as unknown as FactCheckResult),
    tweet_id: req.tweet_id,
  };
  yield { type: "claims", claims: result.claims.map((cr) => cr.claim) };
  const per = MOCK_LATENCY_MS / Math.max(result.claims.length, 1);
  for (const cr of result.claims) {
    await new Promise((r) => setTimeout(r, per));
    yield { type: "claim", result: cr };
  }
  yield { type: "done", result };
}

/** 流式核查：渐进消费 claims → claim×N → done（或抛 FactCheckError）。*/
export function factCheckStream(
  req: FactCheckRequest,
): AsyncGenerator<StreamEvent> {
  return USE_MOCK ? factCheckStreamMock(req) : factCheckStreamReal(req);
}

// ---- 用户反馈 ----
//
// 无后端后，反馈没有上报目标。保留 👍/👎 的价值在于：存本机，
// 用户可在设置页自愿导出发给开发者。不自动上传——这是「不设服务器」的代价，
// 也是隐私政策能写成「不收集任何数据」的前提。

export interface FeedbackPayload {
  tweet_id: string;
  text: string;
  our_verdict: Verdict;
  our_confidence: number;
  rating: "up" | "down";
  models: Record<string, string>;
}

const FEEDBACK_FIELD = "feedback_log";
const FEEDBACK_CAP = 200; // 只留最近 200 条，避免无上限占用本地配额

/** 把一条反馈追加到本机日志。纯本地，不发网络。*/
export async function recordFeedback(payload: FeedbackPayload): Promise<boolean> {
  if (USE_MOCK) return true;
  if (!chrome.runtime?.id) return false;
  try {
    const store = await chrome.storage.local.get(FEEDBACK_FIELD);
    const log = Array.isArray(store[FEEDBACK_FIELD]) ? store[FEEDBACK_FIELD] : [];
    log.push({ ...payload, at: new Date().toISOString() });
    await chrome.storage.local.set({
      [FEEDBACK_FIELD]: log.slice(-FEEDBACK_CAP),
    });
    return true;
  } catch {
    return false;
  }
}
