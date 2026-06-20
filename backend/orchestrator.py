"""编排器：串起 claim → evaluator → critic，产出 FactCheckResult。

engine-wiring worktree 的主战场。注入三个 agent（真实或 mock），
对外暴露单一入口 Orchestrator.check()。
"""

from __future__ import annotations

import asyncio
import time
from typing import Optional

from agents.base import ClaimAgent, EvaluatorAgent, CriticAgent
from contracts.models import FactCheckRequest, FactCheckResult, Verdict
from core import aggregate, safe_check_claim


class Orchestrator:
    """核查管道编排器。"""

    def __init__(
        self,
        claim_agent: ClaimAgent,
        evaluator: EvaluatorAgent,
        critic: CriticAgent,
        model_versions: Optional[dict[str, str]] = None,
    ) -> None:
        self._claim_agent = claim_agent
        self._evaluator = evaluator
        self._critic = critic
        self._model_versions = model_versions or {}

    async def check(self, request: FactCheckRequest) -> FactCheckResult:
        """主流程：抽取断言 → 并行评估每条 → 聚合。"""
        started = time.monotonic()

        claims = await self._claim_agent.extract(request.text, request.lang)
        checkable = [c for c in claims if c.checkable]

        # 各断言相互独立 → 并行评估，缩短端到端时延。
        # safe_check_claim：单条超时/异常一律降级为 UNVERIFIABLE，绝不拖垮整条推文。
        results = await asyncio.gather(
            *(safe_check_claim(c, self._evaluator, self._critic) for c in checkable)
        )

        overall, confidence, summary = aggregate(request.tweet_id, list(results))
        elapsed_ms = int((time.monotonic() - started) * 1000)

        return FactCheckResult(
            tweet_id=request.tweet_id,
            overall_verdict=overall,
            overall_confidence=confidence,
            summary=summary,
            claims=list(results),
            processing_ms=elapsed_ms,
            model_versions=self._model_versions,
        )
