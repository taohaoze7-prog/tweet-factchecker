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
    scored = [r for r in results if r.final_verdict in _VERDICT_SCORE]
    if not scored:
        return Verdict.UNVERIFIABLE, 0.0, "无可核查的事实性断言。"

    weight = sum(r.final_confidence for r in scored) or 1.0
    avg = sum(_VERDICT_SCORE[r.final_verdict] * r.final_confidence for r in scored) / weight
    overall = _nearest_verdict(avg)
    confidence = round(weight / len(scored), 3)
    summary = f"核查 {len(scored)} 条断言，整体判定：{overall.value}。"
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
