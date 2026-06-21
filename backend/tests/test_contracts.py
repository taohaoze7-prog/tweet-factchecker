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
    ClaimResult,
    Critique,
    Evaluation,
    FactCheckRequest,
    FactCheckResult,
    Verdict,
)
from core import aggregate, degraded_result, resolve_claim
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


def _verified(cid: str, verdict: Verdict, conf: float) -> "ClaimResult":
    """构造一条「已核实」的 ClaimResult（critic 认可初判）。"""
    return resolve_claim(
        Claim(id=cid, text="x", checkable=True),
        Evaluation(claim_id=cid, verdict=verdict, confidence=conf, reasoning="r"),
        Critique(claim_id=cid, approved=True),
    )


def test_aggregate_summary_exposes_unverified_coverage() -> None:
    """混合场景：整体判定只看已核实，但未核实数必须在 summary 里点明。"""
    results = [
        _verified("c1", Verdict.TRUE, 0.9),
        degraded_result(Claim(id="c2", text="y", checkable=True), "超时"),
        degraded_result(Claim(id="c3", text="z", checkable=True), "异常"),
    ]
    overall, conf, summary = aggregate("t1", results)
    assert overall == Verdict.TRUE          # 仅基于 c1
    assert conf == 0.9                       # 未核实的不拉低均值
    assert "共 3 条" in summary
    assert "1 条已核实" in summary
    assert "2 条无法核实" in summary         # 透明化：不再被头部一笔带过


def test_aggregate_summary_all_unverifiable_with_claims() -> None:
    """有断言但全军覆没：话术区别于「压根没断言」。"""
    results = [degraded_result(Claim(id="c1", text="x", checkable=True), "超时")]
    overall, conf, summary = aggregate("t1", results)
    assert overall == Verdict.UNVERIFIABLE
    assert conf == 0.0
    assert "共 1 条断言，均无法核实" in summary


# ─────────────────── 容错：单条 agent 抛错不拖垮整条推文 ───────────────────

@pytest.mark.asyncio
async def test_orchestrator_degrades_on_agent_failure() -> None:
    """evaluator 抛异常 → 该 claim 降级为 UNVERIFIABLE，请求不崩。"""
    from mocks import MockClaimAgent, MockCriticAgent
    from orchestrator import Orchestrator

    class BoomEvaluator:
        async def evaluate(self, claim):  # noqa: ANN001
            raise RuntimeError("模拟 evaluator 炸了")

    orch = Orchestrator(
        claim_agent=MockClaimAgent(),
        evaluator=BoomEvaluator(),
        critic=MockCriticAgent(),
        model_versions={"claim": "mock", "evaluator": "boom", "critic": "mock"},
    )
    result = await orch.check(
        FactCheckRequest(tweet_id="t-boom", text="地球是圆的。月球绕地球转。")
    )
    # 没有抛异常 = 整条请求存活
    assert result.tweet_id == "t-boom"
    assert result.claims, "降级也应有 claim 结果"
    # 每条都降级为 UNVERIFIABLE，置信度 0
    for cr in result.claims:
        assert cr.final_verdict == Verdict.UNVERIFIABLE
        assert cr.final_confidence == 0.0
        assert cr.critique.concerns, "降级应留下原因"


# ─────────────────── 缓存：重复推文复用结论，不重跑管道 ───────────────────

@pytest.mark.asyncio
async def test_caching_checker_hit_miss_and_tweet_id_backfill() -> None:
    from cache import CachingChecker, ResultCache
    from mocks import build_mock_orchestrator

    calls = {"n": 0}
    inner = build_mock_orchestrator()
    _orig = inner.check

    async def counting_check(req):  # noqa: ANN001 — 计数包装
        calls["n"] += 1
        return await _orig(req)

    inner.check = counting_check  # type: ignore[method-assign]
    checker = CachingChecker(inner, ResultCache(ttl_s=60))

    r1 = await checker.check(FactCheckRequest(tweet_id="a", text="同一条推文。"))
    r2 = await checker.check(FactCheckRequest(tweet_id="b", text="同一条推文。"))
    r3 = await checker.check(FactCheckRequest(tweet_id="c", text="另一条推文。"))

    # 同文本第二次命中缓存 → 内层只被调了 2 次（a、c），b 命中
    assert calls["n"] == 2
    # 命中也要回填当前请求的 tweet_id，不能带出别条的 id
    assert r1.tweet_id == "a"
    assert r2.tweet_id == "b"
    assert r3.tweet_id == "c"
    # 内容一致（同文本同结论）
    assert r2.overall_verdict == r1.overall_verdict


@pytest.mark.asyncio
async def test_caching_checker_ttl_expiry() -> None:
    from cache import CachingChecker, ResultCache
    from mocks import build_mock_orchestrator

    calls = {"n": 0}
    inner = build_mock_orchestrator()
    _orig = inner.check

    async def counting_check(req):  # noqa: ANN001
        calls["n"] += 1
        return await _orig(req)

    inner.check = counting_check  # type: ignore[method-assign]
    checker = CachingChecker(inner, ResultCache(ttl_s=0.0))  # 立即过期

    await checker.check(FactCheckRequest(tweet_id="a", text="x。"))
    await checker.check(FactCheckRequest(tweet_id="a", text="x。"))
    # TTL=0 → 每次都过期 miss → 内层被调 2 次
    assert calls["n"] == 2


# ─────────────────── 流式：事件序列 claims → claim×N → done ───────────────────

@pytest.mark.asyncio
async def test_check_stream_event_order() -> None:
    from mocks import build_mock_orchestrator
    from stream_events import ClaimsEvent, ClaimDoneEvent, DoneEvent

    orch = build_mock_orchestrator()
    events = [
        ev
        async for ev in orch.check_stream(
            FactCheckRequest(tweet_id="t", text="地球是圆的。月球绕地球转。")
        )
    ]
    # 首个必是骨架，末个必是 done
    assert isinstance(events[0], ClaimsEvent)
    assert isinstance(events[-1], DoneEvent)
    # 中间全是逐条 claim 事件
    middle = events[1:-1]
    assert middle and all(isinstance(e, ClaimDoneEvent) for e in middle)
    # 骨架里的 claim 数 == 逐条事件数 == 最终 result.claims 数
    assert len(events[0].claims) == len(middle) == len(events[-1].result.claims)
    # 每个 claim 事件的 id 都在骨架里
    skeleton_ids = {c.id for c in events[0].claims}
    assert {e.result.claim.id for e in middle} == skeleton_ids


@pytest.mark.asyncio
async def test_caching_check_stream_hit_emits_single_done() -> None:
    from cache import CachingChecker, ResultCache
    from mocks import build_mock_orchestrator
    from stream_events import DoneEvent

    checker = CachingChecker(build_mock_orchestrator(), ResultCache(ttl_s=60))
    req = FactCheckRequest(tweet_id="a", text="同一条。")

    # 第一次：完整流（填充缓存）
    first = [ev async for ev in checker.check_stream(req)]
    assert any(isinstance(e, DoneEvent) for e in first)

    # 第二次同文本、不同 id：命中缓存 → 只推一个 done，且 tweet_id 回填
    req2 = FactCheckRequest(tweet_id="b", text="同一条。")
    second = [ev async for ev in checker.check_stream(req2)]
    assert len(second) == 1
    assert isinstance(second[0], DoneEvent)
    assert second[0].result.tweet_id == "b"


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
