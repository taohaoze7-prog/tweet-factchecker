// 结构化输出：用「强制工具调用」拿到固定形状的 JSON。
//
// 服务端 web_search 不能与强制工具调用共存于同一次调用，所以 evaluator 走两段式
// （先联网搜证拿文本，再用本模块整理成结构）。这是后端时期就踩过的坑，照搬结论。
//
// Python 侧用 Pydantic 同时提供 JSON Schema 与运行时校验；TS 没有等价物，
// 因此每个草稿类型手写「schema + 校验函数」一对，校验失败一律返回 null，
// 由各 agent 自行降级——绝不把没校验过的模型输出灌进契约对象。

import { createMessage, type ContentBlock } from "./anthropic";

/** 从模型拿一个经校验的 T；任何环节失败返回 null。*/
export async function extractStructured<T>(
  apiKey: string,
  opts: {
    model: string;
    system: string;
    user: string;
    schema: object;
    toolName: string;
    toolDescription: string;
    maxTokens?: number;
    validate: (raw: unknown) => T | null;
  },
  signal?: AbortSignal,
): Promise<T | null> {
  let resp;
  try {
    resp = await createMessage(
      apiKey,
      {
        model: opts.model,
        max_tokens: opts.maxTokens ?? 2048,
        system: opts.system,
        messages: [{ role: "user", content: opts.user }],
        tools: [
          {
            name: opts.toolName,
            description: opts.toolDescription,
            input_schema: opts.schema,
          },
        ],
        tool_choice: { type: "tool", name: opts.toolName },
      },
      signal,
    );
  } catch (e) {
    // 用户取消要穿透，其余（含 key 失效）交由上层统一处理。
    if (e instanceof DOMException && e.name === "AbortError") throw e;
    throw e;
  }

  const block = resp.content.find(
    (b: ContentBlock) => b.type === "tool_use" && b.name === opts.toolName,
  );
  if (!block || block.input === undefined) return null;
  try {
    return opts.validate(block.input);
  } catch {
    return null;
  }
}

// ---- 通用取值助手：模型输出不可信，每个字段都要过一遍类型闸门 ----

export function asString(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

export function asBool(v: unknown): boolean | null {
  return typeof v === "boolean" ? v : null;
}

/** 数值夹到 [0,1]；NaN / 非数一律回落到 fallback，防止越界污染契约。*/
export function clamp01(v: unknown, fallback = 0): number {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.min(1, n));
}

export function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

/** 取枚举值：不在白名单内返回 null，绝不放行模型自创的枚举。*/
export function asEnum<T extends string>(v: unknown, allowed: readonly T[]): T | null {
  return typeof v === "string" && (allowed as readonly string[]).includes(v)
    ? (v as T)
    : null;
}
