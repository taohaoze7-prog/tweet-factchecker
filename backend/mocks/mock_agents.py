"""固定数据的 mock agent，满足 agents.base 的 Protocol。

用途：
- frontend worktree：起本地后端，浮层有真实形状的数据可渲染。
- engine-wiring worktree：验证编排/聚合逻辑，无需 API key。
- 单元测试：稳定、可断言、零网络。
"""

from __future__ import annotations

from typing import Optional

from contracts.models import (
    Claim,
    Evidence,
    Evaluation,
    Critique,
    Stance,
    Verdict,
)
from orchestrator import Orchestrator


class MockClaimAgent:
    """把推文按句号粗切，前两句标记为可核查。"""

    async def extract(self, text: str, lang: Optional[str] = None) -> list[Claim]:
        sentences = [s.strip() for s in text.replace("。", ".").split(".") if s.strip()]
        return [
            Claim(id=f"c{i + 1}", text=s, checkable=(i < 2))
            for i, s in enumerate(sentences)
        ] or [Claim(id="c1", text=text, checkable=True)]


class MockEvaluatorAgent:
    """对任意断言返回固定的"基本属实"初判 + 一条假证据。"""

    async def evaluate(self, claim: Claim) -> Evaluation:
        return Evaluation(
            claim_id=claim.id,
            verdict=Verdict.MOSTLY_TRUE,
            confidence=0.72,
            evidence=[
                Evidence(
                    source_url="https://example.com/mock-source",
                    title="Mock 来源",
                    snippet="（mock 证据）该说法与公开资料大体一致。",
                    stance=Stance.SUPPORTS,
                    score=0.7,
                )
            ],
            reasoning="（mock）基于单一来源的占位判定，仅供联调。",
        )


class MockCriticAgent:
    """一律认可初判，附一条形式化质疑。"""

    async def critique(self, claim: Claim, evaluation: Evaluation) -> Critique:
        return Critique(
            claim_id=claim.id,
            approved=True,
            adjusted_verdict=None,
            adjusted_confidence=None,
            concerns=["（mock）证据来源单一，正式版需交叉验证。"],
        )


def build_mock_orchestrator() -> Orchestrator:
    """组装一个全 mock 的编排器，供本地起服务 / 测试。"""
    return Orchestrator(
        claim_agent=MockClaimAgent(),
        evaluator=MockEvaluatorAgent(),
        critic=MockCriticAgent(),
        model_versions={
            "claim": "mock",
            "evaluator": "mock",
            "critic": "mock",
        },
    )
