// Anthropic API 直连客户端（浏览器扩展环境）。
//
// 为什么不用官方 SDK：SDK 体积大、依赖 Node 垫片，而我们只需要 messages.create
// 一个端点。手写 fetch 让 background worker 保持单文件 IIFE，也让审核方能一眼
// 看清全部出网行为——商店审核时这是加分项。
//
// 浏览器直连要点：Anthropic 默认拦截浏览器 origin 的请求（防 key 泄漏），
// 必须带 anthropic-dangerous-direct-browser-access: true 才放行。
// 在扩展里这是安全的：key 存在用户自己的 chrome.storage.local，
// 请求从 service worker 发出，不经过任何第三方服务器。

const API_URL = "https://api.anthropic.com/v1/messages";
const API_VERSION = "2023-06-01";

/** 模型分层：抽断言用 Haiku（高频、轻量），搜证与复核用 Sonnet（需要推理与联网）。*/
export const MODELS = {
  claim: "claude-haiku-4-5",
  evaluator: "claude-sonnet-5",
  critic: "claude-sonnet-5",
} as const;

/** 调用方可感知的错误类型，用于给用户不同的可操作提示。*/
export type ApiErrorKind =
  | "no_key"
  | "invalid_key"
  | "rate_limit"
  | "credit"
  | "network"
  | "server"
  | "unknown";

export class AnthropicError extends Error {
  constructor(
    readonly kind: ApiErrorKind,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "AnthropicError";
  }
}

/** 把 HTTP 状态 + 错误体映射成用户能据以行动的错误类型。*/
function classify(status: number, body: string): AnthropicError {
  // 400 也可能是余额问题，Anthropic 用 error.type 区分，优先看它。
  let errType = "";
  try {
    errType = JSON.parse(body)?.error?.type ?? "";
  } catch {
    /* 非 JSON 错误体，退回按状态码判断 */
  }

  if (status === 401 || errType === "authentication_error") {
    return new AnthropicError("invalid_key", "API Key 无效或已被撤销", status);
  }
  if (status === 403 || errType === "permission_error") {
    return new AnthropicError("invalid_key", "API Key 无权访问该模型", status);
  }
  if (errType === "billing_error" || /credit balance/i.test(body)) {
    return new AnthropicError("credit", "账户额度不足，请前往 Anthropic 控制台充值", status);
  }
  if (status === 429) {
    return new AnthropicError("rate_limit", "请求过于频繁，请稍后再试", status);
  }
  if (status >= 500) {
    return new AnthropicError("server", `Anthropic 服务暂时不可用（${status}）`, status);
  }
  return new AnthropicError("unknown", `请求失败（${status}）`, status);
}

export interface MessageParams {
  model: string;
  max_tokens: number;
  system: string;
  messages: Array<{ role: "user" | "assistant"; content: string }>;
  tools?: unknown[];
  tool_choice?: unknown;
}

/** 响应内容块（只声明我们会读的字段）。*/
export interface ContentBlock {
  type: string;
  text?: string;
  name?: string;
  input?: unknown;
  /** web_search_tool_result 的载荷：成功时是结果数组，失败时是错误对象。*/
  content?: unknown;
}

/** 服务端 web_search 返回的单条结果。*/
export interface SearchResult {
  url: string;
  title?: string;
}

export interface MessageResponse {
  content: ContentBlock[];
  stop_reason?: string;
}

/**
 * 调 messages 端点。
 *
 * signal 用于用户关闭卡片时中止在途请求——不中止的话，worker 会白白烧完
 * 用户的额度（每次核查是真金白银，这条很重要）。
 */
export async function createMessage(
  apiKey: string,
  params: MessageParams,
  signal?: AbortSignal,
): Promise<MessageResponse> {
  if (!apiKey) {
    throw new AnthropicError("no_key", "尚未配置 API Key");
  }

  let resp: Response;
  try {
    resp = await fetch(API_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": API_VERSION,
        // 允许从浏览器 origin 直连；key 不经第三方服务器。
        "anthropic-dangerous-direct-browser-access": "true",
      },
      body: JSON.stringify(params),
      signal,
    });
  } catch (e) {
    // AbortError 是用户主动取消，原样上抛让调用方区别对待。
    if (e instanceof DOMException && e.name === "AbortError") throw e;
    throw new AnthropicError("network", "网络请求失败，请检查网络连接");
  }

  if (!resp.ok) {
    throw classify(resp.status, await resp.text().catch(() => ""));
  }
  return (await resp.json()) as MessageResponse;
}

/** 取响应里全部 text 块拼接（搜证阶段用）。*/
export function textOf(resp: MessageResponse): string {
  return resp.content
    .filter((b) => b.type === "text" && b.text)
    .map((b) => b.text as string)
    .join("\n")
    .trim();
}

/**
 * 取服务端 web_search 命中的真实来源。
 *
 * 关键：搜索结果的 URL 在 `web_search_tool_result` 块里，**不在** text 块中。
 * 模型的散文常写成「据 NASA 官网」而不带 URL，只读 text 会让下游拿不到任何
 * 可引用链接——证据全被 URL 闸门丢弃，最终变成「有判定但零来源」。
 * 把这些真实 URL 显式喂给结构化阶段，它才有东西可引。
 *
 * 搜索失败时 content 是错误对象而非数组，此处一并容错。
 */
export function searchResultsOf(resp: MessageResponse): SearchResult[] {
  const out: SearchResult[] = [];
  for (const block of resp.content) {
    if (block.type !== "web_search_tool_result") continue;
    if (!Array.isArray(block.content)) continue; // 错误对象，跳过
    for (const r of block.content) {
      if (typeof r !== "object" || r === null) continue;
      const rec = r as Record<string, unknown>;
      if (typeof rec.url === "string" && rec.url) {
        out.push({
          url: rec.url,
          title: typeof rec.title === "string" ? rec.title : undefined,
        });
      }
    }
  }
  return out;
}

/**
 * 轻量校验 Key 是否可用：发一个 1 token 的最小请求。
 * 设置页保存前调用，让用户当场知道 key 对不对，而不是第一次核查才报错。
 */
export async function validateKey(apiKey: string): Promise<void> {
  await createMessage(apiKey, {
    model: MODELS.claim,
    max_tokens: 1,
    system: "",
    messages: [{ role: "user", content: "hi" }],
  });
}
