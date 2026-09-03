// ClaimAgent：从推文正文抽取可核查断言。模型 Haiku（高频、轻量）。
//
// id 由本文件按抽取顺序生成（c1/c2…），不信任模型自填——契约要求 id 唯一稳定。
//
// 关键：抽不到可核查断言时返回空数组，上层秒回「无可核查断言」。
// 绝不把 "Great" 这类表态硬造成 checkable 塞进昂贵的搜证管道
// ——那正是早期卡满超时、且白烧用户额度的根因。

import type { Claim } from "../types";
import { MODELS } from "./anthropic";
import { asArray, asBool, asString, extractStructured } from "./structured";

const SYSTEM = `你是事实核查管道的「断言抽取器」。输入一条社交媒体推文，输出其中可核查的事实性断言。

规则：
1. 把复合句拆成独立的、自包含的单条断言（每条能脱离上下文被验证）。
2. checkable=true 仅用于客观、可被证据证实或证伪的事实性陈述
   （数据、事件、引述、因果主张）。
3. checkable=false 用于主观意见、预测、玩笑、反问、纯情绪表达。
4. text 用推文原文的语言，规范化为陈述句，去掉表情/话题标签噪声。
5. 没有任何可核查内容时返回空列表。`;

const SCHEMA = {
  type: "object",
  properties: {
    claims: {
      type: "array",
      description: "抽取出的断言列表，没有则为空数组",
      items: {
        type: "object",
        properties: {
          text: { type: "string", description: "规范化后的断言陈述" },
          checkable: { type: "boolean", description: "是否为可核查的事实性断言" },
        },
        required: ["text", "checkable"],
      },
    },
  },
  required: ["claims"],
};

interface ClaimDraft {
  text: string;
  checkable: boolean;
}

function validate(raw: unknown): { claims: ClaimDraft[] } | null {
  if (typeof raw !== "object" || raw === null) return null;
  const drafts: ClaimDraft[] = [];
  for (const item of asArray((raw as Record<string, unknown>).claims)) {
    if (typeof item !== "object" || item === null) continue;
    const rec = item as Record<string, unknown>;
    const text = asString(rec.text);
    const checkable = asBool(rec.checkable);
    // text 缺失就整条丢弃；checkable 缺失按保守处理（不进搜证管道）。
    if (text) drafts.push({ text, checkable: checkable ?? false });
  }
  return { claims: drafts };
}

export async function extractClaims(
  apiKey: string,
  text: string,
  lang?: string | null,
  signal?: AbortSignal,
): Promise<Claim[]> {
  const hint = lang ? `\n（推文语言提示：${lang}）` : "";
  const parsed = await extractStructured(
    apiKey,
    {
      model: MODELS.claim,
      system: SYSTEM,
      user: `推文：\n${text}${hint}`,
      schema: SCHEMA,
      toolName: "record_claims",
      toolDescription: "登记从推文中抽取出的可核查断言列表。",
      maxTokens: 1024,
      validate,
    },
    signal,
  );
  if (!parsed) return [];

  return parsed.claims.map((d, i) => ({
    id: `c${i + 1}`,
    text: d.text,
    checkable: d.checkable,
  }));
}
