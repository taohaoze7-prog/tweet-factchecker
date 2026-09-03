// 核查管道：断言收敛 + 整体聚合 + 流式编排。
//
// 对应后端的 core.py + orchestrator.py。搬进扩展后省掉了 SSE 编解码——
// 管道就在 worker 里跑，事件直接经 port 回传 content script。

import type {
  Claim,
  ClaimResult,
  Critique,
  Evaluation,
  FactCheckRequest,
  FactCheckResult,
  Verdict,
} from "../types";
import { MODELS } from "./anthropic";
import { extractClaims } from "./claim";
import { critiqueClaim } from "./critic";
import { evaluateClaim } from "./evaluator";

/** 聚合整体判定时各结论的数值权重。unverifiable 不参与打分（见 aggregate）。*/
const VERDICT_SCORE: Partial<Record<Verdict, number>> = {
  true: 1.0,
  mostly_true: 0.75,
  mixed: 0.5,
  mostly_false: 0.25,
  false: 0.0,
};

/** 单条断言评估超时（毫秒）。两段式联网搜证 + 复核，正常一条走完远快于此；
 *  150s 是「病态卡死」的止损线，超时降级而非拖垮整条推文。*/
const CLAIM_TIMEOUT_MS = 150_000;

/** 依据 Critique 收敛单条断言的最终结论。*/
export function resolveClaim(
  claim: Claim,
  evaluation: Evaluation,
  critique: Critique,
): ClaimResult {
  const finalVerdict = critique.approved
    ? evaluation.verdict
    : (critique.adjusted_verdict ?? evaluation.verdict);
  const finalConfidence = critique.approved
    ? evaluation.confidence
    : (critique.adjusted_confidence ?? evaluation.confidence);
  return {
    claim,
    evaluation,
    critique,
    final_verdict: finalVerdict,
    final_confidence: finalConfidence,
  };
}

/** 把 [0,1] 分数映射回最接近的 Verdict 档位。*/
function nearestVerdict(score: number): Verdict {
  let best: Verdict = "mixed";
  let bestDist = Infinity;
  for (const [v, s] of Object.entries(VERDICT_SCORE) as [Verdict, number][]) {
    const d = Math.abs(s - score);
    if (d < bestDist) {
      bestDist = d;
      best = v;
    }
  }
  return best;
}

/**
 * 聚合多条 ClaimResult 为整体判定。
 *
 * 仅对可数值化的判定（排除 unverifiable）按 confidence 加权平均；
 * 全部不可核查则整体 unverifiable。
 */
export function aggregate(
  results: ClaimResult[],
): { verdict: Verdict; confidence: number; summary: string } {
  const total = results.length;
  const scored = results.filter((r) => r.final_verdict in VERDICT_SCORE);

  if (!scored.length) {
    // 有断言但全部无法核实 vs 压根没抽到断言，话术要分开，避免笼统。
    return {
      verdict: "unverifiable",
      confidence: 0,
      summary: total ? `共 ${total} 条断言，均无法核实。` : "无可核查的事实性断言。",
    };
  }

  const weight = scored.reduce((s, r) => s + r.final_confidence, 0) || 1;
  const avg =
    scored.reduce(
      (s, r) => s + (VERDICT_SCORE[r.final_verdict] as number) * r.final_confidence,
      0,
    ) / weight;
  const verdict = nearestVerdict(avg);
  const confidence = Math.round((weight / scored.length) * 1000) / 1000;

  // 透明化覆盖率：整体判定只基于已核实的断言，未核实的必须在结论里明说，
  // 否则「3 条里只核实 1 条」会被头部 verdict 一笔带过，误导读者。
  const unverified = total - scored.length;
  const summary = unverified
    ? `共 ${total} 条断言，${scored.length} 条已核实，整体判定：${verdict}；` +
      `另有 ${unverified} 条无法核实，未计入整体判定。`
    : `核查 ${total} 条断言，整体判定：${verdict}。`;

  return { verdict, confidence, summary };
}

/** 把单条断言降级为 unverifiable——某条失败时降级该条，绝不拖垮整条推文。*/
export function degradedResult(claim: Claim, reason: string): ClaimResult {
  return {
    claim,
    evaluation: {
      claim_id: claim.id,
      verdict: "unverifiable",
      confidence: 0,
      evidence: [],
      reasoning: `评估未完成，降级为无法核实：${reason}`,
    },
    critique: {
      claim_id: claim.id,
      approved: true,
      adjusted_verdict: null,
      adjusted_confidence: null,
      concerns: [`管道异常降级：${reason}`],
    },
    final_verdict: "unverifiable",
    final_confidence: 0,
  };
}

/** 单条断言走完 evaluator → critic → 收敛，超时/异常一律降级，**绝不向上抛**。*/
async function safeCheckClaim(
  apiKey: string,
  claim: Claim,
  signal: AbortSignal,
): Promise<ClaimResult> {
  // 用独立的 controller 串联外部 signal 与本条超时，超时后能真正掐断在途请求
  // ——否则请求还在后台跑，继续烧用户额度。
  const ctrl = new AbortController();
  const onAbort = () => ctrl.abort();
  signal.addEventListener("abort", onAbort, { once: true });

  // 单一定时器：先置标志再 abort，保证 catch 里读到的 timedOut 一定是准的。
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    ctrl.abort();
  }, CLAIM_TIMEOUT_MS);

  try {
    const evaluation = await evaluateClaim(apiKey, claim, ctrl.signal);
    const critique = await critiqueClaim(apiKey, claim, evaluation, ctrl.signal);
    return resolveClaim(claim, evaluation, critique);
  } catch (e) {
    // 用户主动取消要穿透到上层，别伪装成「降级结果」。
    if (signal.aborted) throw e;
    if (timedOut) {
      return degradedResult(claim, `评估超时（>${CLAIM_TIMEOUT_MS / 1000}s）`);
    }
    const name = e instanceof Error ? e.name : "Error";
    const msg = e instanceof Error ? e.message : String(e);
    return degradedResult(claim, `${name}: ${msg}`);
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", onAbort);
  }
}

/** 流式事件，与 stream.ts 的 StreamEvent 同形。*/
export type PipelineEvent =
  | { type: "claims"; claims: Claim[] }
  | { type: "claim"; result: ClaimResult }
  | { type: "done"; result: FactCheckResult };

/**
 * 流式主流程：先推断言骨架，再按完成顺序逐条推结果，最后推最终聚合。
 *
 * 总时长与一次性调用相同（各条并行），但前端能渐进渲染、消除"干等"。
 */
export async function* checkStream(
  apiKey: string,
  request: FactCheckRequest,
  signal: AbortSignal,
): AsyncGenerator<PipelineEvent> {
  const started = Date.now();

  const claims = await extractClaims(apiKey, request.text, request.lang, signal);
  const checkable = claims.filter((c) => c.checkable);
  yield { type: "claims", claims: checkable };

  const results: ClaimResult[] = [];
  if (checkable.length) {
    // 各断言相互独立 → 并行评估。用一个「谁先完成先出队」的队列实现 as_completed 语义。
    const pending = new Map<number, Promise<{ i: number; result: ClaimResult }>>();
    checkable.forEach((c, i) => {
      pending.set(
        i,
        safeCheckClaim(apiKey, c, signal).then((result) => ({ i, result })),
      );
    });

    while (pending.size) {
      const { i, result } = await Promise.race(pending.values());
      pending.delete(i);
      results.push(result);
      yield { type: "claim", result };
    }
  }

  const { verdict, confidence, summary } = aggregate(results);
  yield {
    type: "done",
    result: {
      tweet_id: request.tweet_id,
      overall_verdict: verdict,
      overall_confidence: confidence,
      summary,
      claims: results,
      processing_ms: Date.now() - started,
      model_versions: { ...MODELS },
    },
  };
}
