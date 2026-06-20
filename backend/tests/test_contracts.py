"""契约 + 收敛逻辑单测 + mock 链路 HTTP 集成测试（确定性，零网络）。

分工：
- 单测：resolve_claim / aggregate 的收敛逻辑。
- 集成：过 FastAPI app（ASGI）打 /factcheck，验证 mock 链路端到端 + 契约形状。
- 真实链路（需 key、非确定性）不在 pytest，走 `python smoke.py` 的 real 分支。
"""

from __future__ import annotations

import httpx
import pytest

from app import create_app
from contracts.models import (
    Claim,
    Critique,
    Evaluation,
    FactCheckResult,
    Verdict,
)
from core import aggregate, resolve_claim
from mocks import build_mock_orchestrator


# ─────────────────────────── 单测：收敛逻辑 ───────────────────────────

def test_resolve_claim_uses_adjusted_when_not_approved() -> None:
    cr = resolve_claim(
        Claim(id="c1", text="x", checkable=True),
        Evaluation(claim_id="c1", verdict=Verdict.TRUE, confidence=0.9, reasoning="r"),
        Critique(
            claim_id="c1",
            approved=False,
            adjusted_verdict=Verdict.FALSE,
            adjusted_confidence=0.4,
        ),
    )
    assert cr.final_verdict == Verdict.FALSE
    assert cr.final_confidence == 0.4


def test_resolve_claim_keeps_evaluation_when_approved() -> None:
    cr = resolve_claim(
        Claim(id="c1", text="x", checkable=True),
        Evaluation(claim_id="c1", verdict=Verdict.MOSTLY_TRUE, confidence=0.8, reasoning="r"),
        Critique(claim_id="c1", approved=True),
    )
    assert cr.final_verdict == Verdict.MOSTLY_TRUE
    assert cr.final_confidence == 0.8


def test_aggregate_all_unverifiable() -> None:
    overall, conf, _ = aggregate("t1", [])
    assert overall == Verdict.UNVERIFIABLE
    assert conf == 0.0


# ─────────────────────── 集成：mock 链路过 HTTP ───────────────────────

@pytest.mark.asyncio
async def test_factcheck_http_mock_path() -> None:
    app = create_app(build_mock_orchestrator())
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as c:
        resp = await c.post(
            "/factcheck",
            json={"tweet_id": "t123", "text": "地球是圆的。月球绕地球转。"},
        )
    assert resp.status_code == 200
    result = FactCheckResult.model_validate(resp.json())
    assert result.tweet_id == "t123"
    assert result.claims, "至少应核查一条断言"
    assert 0.0 <= result.overall_confidence <= 1.0
    for cr in result.claims:
        assert cr.final_verdict in Verdict
        assert cr.claim.id == cr.evaluation.claim_id == cr.critique.claim_id
