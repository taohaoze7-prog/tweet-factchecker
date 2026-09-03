// CriticAgent：独立复核评估员的初判，扮演「魔鬼代言人」。模型 Sonnet。
//
// claim_id 强制写入，adjusted_confidence clamp 到 [0,1]。
// 约定：approved=false 时必须有 adjusted_verdict（缺失回落到原判定）且至少一条
// concern，避免「不认可却说不出问题」的空壳复核。
// 复核本身失败时保守认可初判并标注复核缺失，绝不阻断管道。

import type { Claim, Critique, Evaluation, Verdict } from "../types";
import { MODELS } from "./anthropic";
import { asArray, asBool, asEnum, asString, clamp01, extractStructured } from "./structured";

const VERDICTS = [
  "true",
  "mostly_true",
  "mixed",
  "mostly_false",
  "false",
  "unverifiable",
] as const satisfies readonly Verdict[];

const SYSTEM = `你是事实核查管道的「复核官」，独立复核评估员的初判，专挑漏洞。

审查维度：
1. 证据是否充分、是否单一来源、是否存在来源偏见或利益冲突。
2. verdict 与证据是否匹配，是否过度自信或过度保守。
3. 推理是否有逻辑跳步、是否把相关当因果、是否忽略反例。

输出：
- approved=true：认可初判，concerns 可为空（也可给提醒）。
- approved=false：必须给 adjusted_verdict（修正判定），并在 concerns 列出具体质疑点。
- adjusted_confidence 可选，∈[0,1]。
- concerns 用断言原文的语言书写。`;

const SCHEMA = {
  type: "object",
  properties: {
    approved: { type: "boolean", description: "是否认可评估员的初判" },
    adjusted_verdict: {
      type: "string",
      enum: VERDICTS,
      description: "不认可时给出的修正判定",
    },
    adjusted_confidence: { type: "number", description: "修正后的置信度，0~1" },
    concerns: {
      type: "array",
      items: { type: "string" },
      description: "具体质疑点",
    },
  },
  required: ["approved", "concerns"],
};

interface CritiqueDraft {
  approved: boolean;
  adjusted_verdict: Verdict | null;
  adjusted_confidence: number | null;
  concerns: string[];
}

function validate(raw: unknown): CritiqueDraft | null {
  if (typeof raw !== "object" || raw === null) return null;
  const rec = raw as Record<string, unknown>;

  const approved = asBool(rec.approved);
  if (approved === null) return null; // 复核结论本身缺失 → 作废，走降级分支

  const concerns: string[] = [];
  for (const c of asArray(rec.concerns)) {
    const s = asString(c);
    if (s) concerns.push(s);
  }

  return {
    approved,
    adjusted_verdict: asEnum(rec.adjusted_verdict, VERDICTS),
    adjusted_confidence:
      rec.adjusted_confidence === undefined || rec.adjusted_confidence === null
        ? null
        : clamp01(rec.adjusted_confidence),
    concerns,
  };
}

function formatEvaluation(evaluation: Evaluation): string {
  const lines = [
    `初判 verdict：${evaluation.verdict}`,
    `置信度 confidence：${evaluation.confidence}`,
    `理由 reasoning：${evaluation.reasoning}`,
    "证据 evidence：",
  ];
  if (evaluation.evidence.length) {
    evaluation.evidence.forEach((e, i) => {
      lines.push(
        `  [${i + 1}] (${e.stance}, score=${e.score}) ${e.title || "（无标题）"} — ${e.source_url}\n` +
          `      摘录：${e.snippet}`,
      );
    });
  } else {
    lines.push("  （无证据）");
  }
  return lines.join("\n");
}

export async function critiqueClaim(
  apiKey: string,
  claim: Claim,
  evaluation: Evaluation,
  signal?: AbortSignal,
): Promise<Critique> {
  const draft = await extractStructured(
    apiKey,
    {
      model: MODELS.critic,
      system: SYSTEM,
      user: `断言：\n${claim.text}\n\n评估员的初判：\n${formatEvaluation(evaluation)}`,
      schema: SCHEMA,
      toolName: "record_critique",
      toolDescription: "登记对评估员初判的独立复核结论。",
      maxTokens: 2048,
      validate,
    },
    signal,
  );

  if (!draft) {
    // 复核失败保守认可初判，但把「没复核成」明说出来，不让用户误以为过了两道关。
    return {
      claim_id: claim.id,
      approved: true,
      adjusted_verdict: null,
      adjusted_confidence: null,
      concerns: ["（复核失败）未能完成独立复核，沿用评估员初判。"],
    };
  }

  const { approved } = draft;
  let adjustedVerdict = draft.adjusted_verdict;
  let concerns = draft.concerns;

  if (!approved) {
    // 不认可却没给修正判定 → 回落原判定；保证至少一条质疑。
    if (!adjustedVerdict) adjustedVerdict = evaluation.verdict;
    if (!concerns.length) concerns = ["复核不认可初判，但未给出具体质疑点。"];
  } else {
    // 认可时修正判定无意义，清空避免下游误用。
    adjustedVerdict = null;
  }

  return {
    claim_id: claim.id,
    approved,
    adjusted_verdict: adjustedVerdict,
    adjusted_confidence:
      !approved && draft.adjusted_confidence !== null ? draft.adjusted_confidence : null,
    concerns,
  };
}
