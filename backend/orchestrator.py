"""编排器：串起 claim → evaluator → critic，产出 FactCheckResult。

engine-wiring worktree 的主战场。注入三个 agent（真实或 mock），
对外暴露 check()（一次性）与 check_stream()（流式进度）。
"""

from __future__ import annotations

import asyncio
import time
from typing import AsyncIterator, Optional

from agents.base import ClaimAgent, EvaluatorAgent, CriticAgent
from contracts.models import ClaimResult, FactCheckRequest, FactCheckResult
from core import aggregate, safe_check_claim
from stream_events import ClaimDoneEvent, ClaimsEvent, DoneEvent, StreamEvent


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
        """一次性主流程：抽取断言 → 并行评估每条 → 聚合。"""
        started = time.monotonic()

        claims = await self._claim_agent.extract(request.text, request.lang)
        checkable = [c for c in claims if c.checkable]

        # 各断言相互独立 → 并行评估，缩短端到端时延。
        # safe_check_claim：单条超时/异常一律降级为 UNVERIFIABLE，绝不拖垮整条推文。
        results = await asyncio.gather(
            *(safe_check_claim(c, self._evaluator, self._critic) for c in checkable)
        )
        return self._build_result(request, list(results), started)

    async def check_stream(
        self, request: FactCheckRequest
    ) -> AsyncIterator[StreamEvent]:
        """流式主流程：先推断言骨架，再按完成顺序逐条推结果，最后推最终聚合。

        总时长与 check() 相同（claims 仍并行），但前端能渐进渲染、消除"干等"。
        """
        started = time.monotonic()

        claims = await self._claim_agent.extract(request.text, request.lang)
        checkable = [c for c in claims if c.checkable]
        yield ClaimsEvent(claims=checkable)

        results: list[ClaimResult] = []
        if checkable:
            tasks = [
                asyncio.create_task(
                    safe_check_claim(c, self._evaluator, self._critic)
                )
                for c in checkable
            ]
            # as_completed：哪条先评完先推哪条，前端按 claim_id 填行。
            for fut in asyncio.as_completed(tasks):
                cr = await fut
                results.append(cr)
                yield ClaimDoneEvent(result=cr)

        yield DoneEvent(result=self._build_result(request, results, started))

    def _build_result(
        self,
        request: FactCheckRequest,
        results: list[ClaimResult],
        started: float,
    ) -> FactCheckResult:
        overall, confidence, summary = aggregate(request.tweet_id, results)
        elapsed_ms = int((time.monotonic() - started) * 1000)
        return FactCheckResult(
            tweet_id=request.tweet_id,
            overall_verdict=overall,
            overall_confidence=confidence,
            summary=summary,
            claims=results,
            processing_ms=elapsed_ms,
            model_versions=self._model_versions,
        )
