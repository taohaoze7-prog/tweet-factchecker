"""引擎核心：单条断言的核查管道 + 结果收敛逻辑。

engine-wiring worktree 负责把 core 串成可运行的 orchestrator。
core 只依赖 agents.base 的 Protocol，与具体实现（真/mock）解耦。
"""

from __future__ import annotations

import asyncio

from agents.base import ClaimAgent, EvaluatorAgent, CriticAgent
from contracts.models import (
    Claim,
    ClaimResult,
    Evaluation,
    Critique,
    FactCheckResult,
    Verdict,
)

# 整体判定聚合时各结论的数值权重（用于 overall_verdict 收敛）。
_VERDICT_SCORE: dict[Verdict, float] = {
    Verdict.TRUE: 1.0,
    Verdict.MOSTLY_TRUE: 0.75,
    Verdict.MIXED: 0.5,
    Verdict.MOSTLY_FALSE: 0.25,
    Verdict.FALSE: 0.0,
}


def resolve_claim(
    claim: Claim, evaluation: Evaluation, critique: Critique
) -> ClaimResult:
    """依据 Critique 收敛单条断言的最终结论。

    critic 不认可时采用 adjusted_*，否则沿用 evaluation。
    """
    if critique.approved:
        final_verdict = evaluation.verdict
        final_confidence = evaluation.confidence
    else:
        final_verdict = critique.adjusted_verdict or evaluation.verdict
        final_confidence = (
            critique.adjusted_confidence
            if critique.adjusted_confidence is not None
            else evaluation.confidence
        )
    return ClaimResult(
        claim=claim,
        evaluation=evaluation,
        critique=critique,
        final_verdict=final_verdict,
        final_confidence=final_confidence,
    )


def aggregate(tweet_id: str, results: list[ClaimResult]) -> tuple[Verdict, float, str]:
    """把多条 ClaimResult 聚合为整体判定。

    规则：仅就可数值化的判定（排除 UNVERIFIABLE）按 confidence 加权平均；
    全部不可核查则整体 UNVERIFIABLE。
    返回 (overall_verdict, overall_confidence, summary)。
    """
    total = len(results)
    scored = [r for r in results if r.final_verdict in _VERDICT_SCORE]
    if not scored:
        # 有断言但全部无法核实 vs 压根没抽到断言，分别给话术，避免笼统。
        if total:
            return Verdict.UNVERIFIABLE, 0.0, f"共 {total} 条断言，均无法核实。"
        return Verdict.UNVERIFIABLE, 0.0, "无可核查的事实性断言。"

    weight = sum(r.final_confidence for r in scored) or 1.0
    avg = sum(_VERDICT_SCORE[r.final_verdict] * r.final_confidence for r in scored) / weight
    overall = _nearest_verdict(avg)
    confidence = round(weight / len(scored), 3)
    # 透明化覆盖率：整体判定只基于已核实的断言，未核实的必须在结论里明说，
    # 否则「3 条里只核实 1 条」也会被头部 verdict 一笔带过，误导读者。
    unverified = total - len(scored)
    if unverified:
        summary = (
            f"共 {total} 条断言，{len(scored)} 条已核实，整体判定：{overall.value}；"
            f"另有 {unverified} 条无法核实，未计入整体判定。"
        )
    else:
        summary = f"核查 {total} 条断言，整体判定：{overall.value}。"
    return overall, confidence, summary


def _nearest_verdict(score: float) -> Verdict:
    """把 [0,1] 分数映射回最接近的 Verdict 档位。"""
    return min(_VERDICT_SCORE, key=lambda v: abs(_VERDICT_SCORE[v] - score))


async def check_claim(
    claim: Claim,
    evaluator: EvaluatorAgent,
    critic: CriticAgent,
) -> ClaimResult:
    """单条断言走完 evaluator → critic → 收敛。"""
    evaluation = await evaluator.evaluate(claim)
    critique = await critic.critique(claim, evaluation)
    return resolve_claim(claim, evaluation, critique)


# 单条断言评估的默认超时（秒）。真实 evaluator 是两段式联网搜证 + critic，
# 共 3 次 sonnet 往返/条，慢但有效。超时只兜病态卡死，不该砍正常联网——给足余量。
CLAIM_TIMEOUT_S: float = 300.0


def degraded_result(claim: Claim, reason: str) -> ClaimResult:
    """把单条断言降级为 UNVERIFIABLE。

    管道内某条 claim 评估失败 / 超时时调用——降级该条，绝不拖垮整条推文。
    """
    evaluation = Evaluation(
        claim_id=claim.id,
        verdict=Verdict.UNVERIFIABLE,
        confidence=0.0,
        evidence=[],
        reasoning=f"评估未完成，降级为无法核实：{reason}",
    )
    critique = Critique(
        claim_id=claim.id,
        approved=True,
        concerns=[f"管道异常降级：{reason}"],
    )
    return ClaimResult(
        claim=claim,
        evaluation=evaluation,
        critique=critique,
        final_verdict=Verdict.UNVERIFIABLE,
        final_confidence=0.0,
    )


async def safe_check_claim(
    claim: Claim,
    evaluator: EvaluatorAgent,
    critic: CriticAgent,
    timeout: float = CLAIM_TIMEOUT_S,
) -> ClaimResult:
    """check_claim 的容错包装：超时 / 异常一律降级，**绝不向上抛**。

    保证 orchestrator 的并行 gather 里任何单条失败都不会让整条请求 500。
    """
    try:
        return await asyncio.wait_for(
            check_claim(claim, evaluator, critic), timeout=timeout
        )
    except asyncio.TimeoutError:
        return degraded_result(claim, f"评估超时（>{timeout:.0f}s）")
    except Exception as exc:  # noqa: BLE001 — 顶层兜底，降级而非中断
        return degraded_result(claim, f"{type(exc).__name__}: {exc}")
