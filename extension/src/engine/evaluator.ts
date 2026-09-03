// EvaluatorAgent：为单条断言联网搜证并给出初判。模型 Sonnet + 服务端 web_search。
//
// 两段式（服务端 web_search 无法与强制工具调用共存于同一次调用）：
//   1. 搜证：挂 web_search 让模型联网，用文字复述发现 + 标注来源 URL。
//   2. 结构化：把搜证文本整理成 verdict/confidence/evidence/reasoning。
//
// claim_id 由本文件强制写入（= 传入 claim.id），概率值代码侧 clamp 到 [0,1]，
// 保证产出的 Evaluation 一定满足契约。搜索受限或拒答时降级为 UNVERIFIABLE，
// 绝不抛错阻断管道。

import type { Claim, Evaluation, Evidence, Stance, Verdict } from "../types";
import { createMessage, MODELS, searchResultsOf, textOf } from "./anthropic";
import { asArray, asEnum, asString, clamp01, extractStructured } from "./structured";

const VERDICTS = [
  "true",
  "mostly_true",
  "mixed",
  "mostly_false",
  "false",
  "unverifiable",
] as const satisfies readonly Verdict[];

const STANCES = ["supports", "refutes", "neutral"] as const satisfies readonly Stance[];

// web_search_20260209 = 带动态过滤的版本，Sonnet 5 支持。
// max_uses 是成本闸门：用户自付费，每次搜索 $0.01，3 次是质量与花费的平衡点。
const WEB_SEARCH_TOOL = {
  type: "web_search_20260209",
  name: "web_search",
  max_uses: 3,
};

const RESEARCH_SYSTEM = `你是事实核查管道的「搜证员」。给定一条可核查断言，用 web_search 联网搜集权威证据。

要求：
1. 至少检索一次；优先一手来源、权威媒体、官方数据，注意交叉验证、避免单一来源。
2. 用断言原文的语言，简要复述你找到的关键事实，并逐条标注来源 URL。
3. 标明每条证据是支持（supports）、反驳（refutes）还是中立/无关（neutral）。
4. 若检索不到可靠证据，明确说明「证据不足」。`;

const STRUCTURE_SYSTEM = `你是事实核查管道的「评估整理员」。基于已给出的搜证记录，对断言给出结构化初判。

要求：
1. 每条 evidence 必须带搜证记录里出现过的真实 source_url，snippet 为支撑判断的关键摘录，
   stance 取 supports / refutes / neutral，score∈[0,1] 表示来源可信度×相关度。
2. verdict 从 true / mostly_true / mixed / mostly_false / false / unverifiable 中选一个，
   confidence∈[0,1] 反映证据强度与一致性。
3. 证据不足、属预测或主观时，verdict=unverifiable 且 confidence 偏低、evidence 可为空。
4. reasoning 必须可追溯到所列证据，用断言原文的语言书写，不要编造来源。`;

const SCHEMA = {
  type: "object",
  properties: {
    verdict: { type: "string", enum: VERDICTS, description: "对断言的判定" },
    confidence: { type: "number", description: "判定置信度，0~1" },
    reasoning: { type: "string", description: "可追溯到证据的判定理由" },
    evidence: {
      type: "array",
      items: {
        type: "object",
        properties: {
          source_url: { type: "string", description: "证据来源 URL" },
          title: { type: "string", description: "来源标题" },
          snippet: { type: "string", description: "支撑判断的关键摘录" },
          stance: { type: "string", enum: STANCES, description: "该证据的立场" },
          score: { type: "number", description: "来源可信度×相关度，0~1" },
        },
        required: ["source_url", "snippet", "stance", "score"],
      },
    },
  },
  required: ["verdict", "confidence", "reasoning", "evidence"],
};

interface EvalDraft {
  verdict: Verdict;
  confidence: number;
  reasoning: string;
  evidence: Evidence[];
}

/**
 * 证据 URL 闸门：必须是可点开的 http(s) 链接。
 *
 * 冒烟实测模型偶尔会在 source_url 里塞相对路径、裸域名或占位文字。
 * 这类「来源」在卡片上和真链接长得一样权威却点不开、无法追溯——
 * 比没有来源更糟。宁可丢掉这条证据，也不让它冒充可核验来源。
 */
function isRealUrl(u: string): boolean {
  try {
    const parsed = new URL(u);
    return (
      (parsed.protocol === "http:" || parsed.protocol === "https:") &&
      // 需要带点的主机名，挡掉 http://搜索结果 这类
      /\./.test(parsed.hostname)
    );
  } catch {
    return false;
  }
}

function validate(raw: unknown): EvalDraft | null {
  if (typeof raw !== "object" || raw === null) return null;
  const rec = raw as Record<string, unknown>;

  // verdict 是整个判定的锚点，模型给了白名单外的值就整条作废（宁可降级为无法核实）。
  const verdict = asEnum(rec.verdict, VERDICTS);
  if (!verdict) return null;

  const evidence: Evidence[] = [];
  for (const item of asArray(rec.evidence)) {
    if (typeof item !== "object" || item === null) continue;
    const e = item as Record<string, unknown>;
    const url = asString(e.source_url);
    const snippet = asString(e.snippet);
    const stance = asEnum(e.stance, STANCES);
    // 缺 URL / 摘录，或 URL 点不开的「证据」没有可追溯性，等同幻觉，直接丢弃。
    if (!url || !snippet || !isRealUrl(url)) continue;
    evidence.push({
      source_url: url,
      title: asString(e.title),
      snippet,
      stance: stance ?? "neutral",
      score: clamp01(e.score, 0.5),
    });
  }

  return {
    verdict,
    confidence: clamp01(rec.confidence),
    reasoning: asString(rec.reasoning) ?? "（评估员未给出理由）",
    evidence,
  };
}

function unverifiable(claim: Claim, reason: string): Evaluation {
  return {
    claim_id: claim.id,
    verdict: "unverifiable",
    confidence: 0,
    evidence: [],
    reasoning: reason,
  };
}

/** 第一段：联网搜证，返回「模型复述 + 真实命中来源清单」。*/
async function gather(
  apiKey: string,
  claim: Claim,
  signal?: AbortSignal,
): Promise<string | null> {
  const resp = await createMessage(
    apiKey,
    {
      model: MODELS.evaluator,
      max_tokens: 4096,
      system: RESEARCH_SYSTEM,
      messages: [
        {
          role: "user",
          content: `待核查断言：\n${claim.text}\n\n请联网搜证，并用文字复述发现、逐条标注来源 URL。`,
        },
      ],
      tools: [WEB_SEARCH_TOOL],
    },
    signal,
  );

  const prose = textOf(resp);
  // 把搜索引擎实际命中的 URL 附在散文之后。模型复述时常省略链接，
  // 只靠散文会让结构化阶段无 URL 可引，证据随后被闸门清空。
  const hits = searchResultsOf(resp);
  if (!prose && !hits.length) return null;

  const sourceList = hits.length
    ? "\n\n实际检索命中的来源（引用证据时必须从中选取 URL，不得自行编造）：\n" +
      hits.map((h, i) => `[${i + 1}] ${h.title ?? "（无标题）"} — ${h.url}`).join("\n")
    : "";

  return `${prose}${sourceList}`.trim() || null;
}

export async function evaluateClaim(
  apiKey: string,
  claim: Claim,
  signal?: AbortSignal,
): Promise<Evaluation> {
  const research = await gather(apiKey, claim, signal);
  if (!research) {
    return unverifiable(claim, "证据检索失败或无可靠来源，暂判为无法核实。");
  }

  const draft = await extractStructured(
    apiKey,
    {
      model: MODELS.evaluator,
      system: STRUCTURE_SYSTEM,
      user: `待核查断言：\n${claim.text}\n\n搜证记录：\n${research}`,
      schema: SCHEMA,
      toolName: "record_evaluation",
      toolDescription: "基于搜证记录登记对断言的结构化初判。",
      maxTokens: 2048,
      validate,
    },
    signal,
  );
  if (!draft) {
    return unverifiable(claim, "证据整理失败，暂判为无法核实。");
  }

  // 铁律：判定必须可追溯。若证据在 URL 闸门后被清空（模型编了来源，或复述里
  // 根本没有可引链接），就不能再挂着 false/true 这类确定判定——那正是
  // 「看起来权威、实则无法核验」。降级为无法核实，并说明原因。
  if (!draft.evidence.length && draft.verdict !== "unverifiable") {
    return unverifiable(
      claim,
      "检索到的来源无法追溯（缺少有效链接），不足以支撑确定判定，暂判为无法核实。",
    );
  }

  return {
    claim_id: claim.id, // 强制对齐，绝不信任模型自填
    verdict: draft.verdict,
    confidence: draft.confidence,
    evidence: draft.evidence,
    reasoning: draft.reasoning,
  };
}
