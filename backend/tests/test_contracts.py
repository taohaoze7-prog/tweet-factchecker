"""契约 + 管道冒烟测试（全 mock，零网络）。

跑通即证明：contracts 形状自洽、Protocol 对齐、orchestrator 收敛逻辑正确。
"""

from __future__ import annotations

import pytest

from contracts.models import FactCheckRequest, Verdict
from core import aggregate, resolve_claim
from contracts.models import Claim, Evaluation, Critique, Verdict
from mocks import build_mock_orchestrator


@pytest.mark.asyncio
async def test_mock_pipeline_end_to_end() -> None:
    orch = build_mock_orchestrator()
    req = FactCheckRequest(
        tweet_id="t123",
        text="地球是圆的。月球绕地球转。",
        author_handle="@someone",
    )
    result = await orch.check(req)

    assert result.tweet_id == "t123"
    assert result.claims, "至少应核查一条断言"
    assert 0.0 <= result.overall_confidence <= 1.0
    assert result.processing_ms >= 0
    # 每条结果都应有收敛后的 final_verdict
    for cr in result.claims:
        assert cr.final_verdict in Verdict
        assert cr.claim.id == cr.evaluation.claim_id == cr.critique.claim_id


def test_resolve_claim_uses_adjusted_when_not_approved() -> None:
    claim = Claim(id="c1", text="x", checkable=True)
    evaluation = Evaluation(
        claim_id="c1", verdict=Verdict.TRUE, confidence=0.9, reasoning="r"
    )
    critique = Critique(
        claim_id="c1",
        approved=False,
        adjusted_verdict=Verdict.FALSE,
        adjusted_confidence=0.4,
    )
    cr = resolve_claim(claim, evaluation, critique)
    assert cr.final_verdict == Verdict.FALSE
    assert cr.final_confidence == 0.4


def test_aggregate_all_unverifiable() -> None:
    overall, conf, summary = aggregate("t1", [])
    assert overall == Verdict.UNVERIFIABLE
    assert conf == 0.0
