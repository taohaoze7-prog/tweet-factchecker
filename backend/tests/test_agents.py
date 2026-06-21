"""agent-layer 单元测试：对 Claude 调用打桩，验证 LLM 之外的确定性逻辑。

原理：三个 agent 的全部不确定性都经过 `ClaudeClient.raw.messages.{parse,create}`。
只要替换这一个边界出口，测试就变成纯函数式 —— 确定、零网络、零成本。

打桩点：
- `messages.parse`  → claim / critic / evaluator 第二段（结构化）
- `messages.create` → evaluator 第一段（web_search 搜证，返回文本块）

不打桩 agent 的私有方法 —— 只 mock 系统边界（外部 API），重构内部不震动测试。
"""

from __future__ import annotations

from types import SimpleNamespace as NS
from typing import Optional

import pytest

from agents.base import ClaimAgent, CriticAgent, EvaluatorAgent
from agents.claim import ClaudeClaimAgent, _ClaimDraft, _ClaimList
from agents.critic import ClaudeCriticAgent, _CritiqueDraft
from agents.evaluator import (
    ClaudeEvaluatorAgent,
    _EvalDraft,
    _EvidenceDraft,
)
from contracts.models import Claim, Critique, Evaluation, Stance, Verdict


# ───────────────────────── 边界打桩工具 ─────────────────────────


def _text_block(t: str):
    """复刻 Anthropic 响应里的 text 内容块形状。"""
    return NS(type="text", text=t)


class _FakeMessages:
    """假的 AsyncAnthropic.messages：parse / create 行为可配置。"""

    def __init__(
        self,
        *,
        parse_output=None,
        create_content=None,
        parse_boom: bool = False,
        create_boom: bool = False,
    ) -> None:
        self._parse_output = parse_output
        self._create_content = create_content or []
        self._parse_boom = parse_boom
        self._create_boom = create_boom

    async def parse(self, **_kw):
        if self._parse_boom:
            raise RuntimeError("parse failed")
        return NS(parsed_output=self._parse_output)

    async def create(self, **_kw):
        if self._create_boom:
            raise RuntimeError("create failed")
        return NS(content=self._create_content)


def make_client(**kw):
    """造一个只暴露 .raw.messages 的假 ClaudeClient。"""
    return NS(raw=NS(messages=_FakeMessages(**kw)))


CLAIM = Claim(id="c1", text="2025 年 GDP 增长 3%", checkable=True)
BASE_EVAL = Evaluation(
    claim_id="c1", verdict=Verdict.TRUE, confidence=0.9, reasoning="r"
)


# ───────────────────────── Protocol 一致性 ─────────────────────────


def test_agents_satisfy_protocols():
    c = make_client()
    assert isinstance(ClaudeClaimAgent(c), ClaimAgent)
    assert isinstance(ClaudeEvaluatorAgent(c), EvaluatorAgent)
    assert isinstance(ClaudeCriticAgent(c), CriticAgent)


# ───────────────────────── ClaimAgent ─────────────────────────


async def test_claim_ids_contiguous_and_filter_empty():
    """空串草稿被过滤后，id 仍连续无缺口。"""
    out = _ClaimList(
        claims=[
            _ClaimDraft(text="GDP +3%", checkable=True),
            _ClaimDraft(text="   ", checkable=True),  # 空串 → 过滤
            _ClaimDraft(text="好消息", checkable=False),
        ]
    )
    claims = await ClaudeClaimAgent(make_client(parse_output=out)).extract("…")
    assert [c.id for c in claims] == ["c1", "c2"]  # 不是 c1/c3
    assert [c.checkable for c in claims] == [True, False]
    assert all(isinstance(c, Claim) for c in claims)


async def test_claim_empty_result_falls_back_to_single_claim():
    out = _ClaimList(claims=[])
    claims = await ClaudeClaimAgent(make_client(parse_output=out)).extract("整条推文")
    assert len(claims) == 1
    assert claims[0].id == "c1" and claims[0].checkable is True
    assert claims[0].text == "整条推文"


async def test_claim_parse_failure_falls_back():
    claims = await ClaudeClaimAgent(make_client(parse_boom=True)).extract("整条推文")
    assert len(claims) == 1 and claims[0].id == "c1"


# ───────────────────────── EvaluatorAgent ─────────────────────────


async def test_evaluator_clamps_and_aligns_claim_id():
    """越界 confidence/score 被夹回 [0,1]，claim_id 强制对齐。"""
    draft = _EvalDraft(
        verdict=Verdict.MOSTLY_TRUE,
        confidence=1.4,  # > 1 → 1.0
        evidence=[
            _EvidenceDraft(
                source_url="https://gov.example",
                title="Stats",
                snippet="+3%",
                stance=Stance.SUPPORTS,
                score=2.0,  # > 1 → 1.0
            )
        ],
        reasoning="官方数据支持",
    )
    client = make_client(
        create_content=[_text_block("据官方,GDP +3%。来源 https://gov.example")],
        parse_output=draft,
    )
    evl = await ClaudeEvaluatorAgent(client).evaluate(CLAIM)
    assert isinstance(evl, Evaluation)
    assert evl.claim_id == "c1"
    assert evl.confidence == 1.0
    assert evl.evidence[0].score == 1.0
    assert evl.verdict == Verdict.MOSTLY_TRUE


async def test_evaluator_drops_evidence_missing_url_or_snippet():
    draft = _EvalDraft(
        verdict=Verdict.MIXED,
        confidence=0.5,
        evidence=[
            _EvidenceDraft(source_url="", snippet="有摘录无链接", stance=Stance.NEUTRAL),
            _EvidenceDraft(source_url="https://ok", snippet="", stance=Stance.NEUTRAL),
            _EvidenceDraft(
                source_url="https://good", snippet="完整", stance=Stance.SUPPORTS
            ),
        ],
        reasoning="证据混杂",
    )
    client = make_client(
        create_content=[_text_block("发现 https://good")], parse_output=draft
    )
    evl = await ClaudeEvaluatorAgent(client).evaluate(CLAIM)
    assert len(evl.evidence) == 1 and evl.evidence[0].source_url == "https://good"


async def test_evaluator_no_research_returns_unverifiable():
    """搜证为空时不调用 parse，直接降级。"""
    client = make_client(create_content=[_text_block("")])  # 空搜证
    evl = await ClaudeEvaluatorAgent(client).evaluate(CLAIM)
    assert evl.verdict == Verdict.UNVERIFIABLE
    assert evl.confidence == 0.0 and evl.evidence == []


async def test_evaluator_structure_failure_returns_unverifiable():
    client = make_client(
        create_content=[_text_block("有发现 https://x")], parse_output=None
    )
    evl = await ClaudeEvaluatorAgent(client).evaluate(CLAIM)
    assert evl.verdict == Verdict.UNVERIFIABLE


async def test_evaluator_search_failure_returns_unverifiable():
    client = make_client(create_boom=True)
    evl = await ClaudeEvaluatorAgent(client).evaluate(CLAIM)
    assert evl.verdict == Verdict.UNVERIFIABLE


# ───────────────────────── CriticAgent ─────────────────────────


async def test_critic_disapprove_backfills_verdict_and_concerns():
    """不认可但模型没给 adjusted_verdict / concerns → 代码补全。"""
    draft = _CritiqueDraft(
        approved=False,
        adjusted_verdict=None,
        adjusted_confidence=-0.2,  # < 0 → 0.0
        concerns=[],
    )
    crt = await ClaudeCriticAgent(make_client(parse_output=draft)).critique(
        CLAIM, BASE_EVAL
    )
    assert isinstance(crt, Critique)
    assert crt.claim_id == "c1" and crt.approved is False
    assert crt.adjusted_verdict == Verdict.TRUE  # 回落到初判
    assert crt.adjusted_confidence == 0.0  # clamp
    assert crt.concerns  # 至少补一条


async def test_critic_approve_clears_adjusted_fields():
    draft = _CritiqueDraft(
        approved=True,
        adjusted_verdict=Verdict.FALSE,  # 认可时应被清空
        adjusted_confidence=0.5,
        concerns=["提醒：来源单一"],
    )
    crt = await ClaudeCriticAgent(make_client(parse_output=draft)).critique(
        CLAIM, BASE_EVAL
    )
    assert crt.approved is True
    assert crt.adjusted_verdict is None and crt.adjusted_confidence is None
    assert crt.concerns  # 认可时仍可带提醒


async def test_critic_failure_falls_back_to_conservative_approve():
    crt = await ClaudeCriticAgent(make_client(parse_boom=True)).critique(
        CLAIM, BASE_EVAL
    )
    assert crt.approved is True and crt.concerns  # 保守认可 + 标注复核缺失
    assert crt.claim_id == "c1"


# ───────────────────────── 参数化：clamp 边界 ─────────────────────────


@pytest.mark.parametrize(
    "raw_conf, expected",
    [(-0.5, 0.0), (0.0, 0.0), (0.73, 0.73), (1.0, 1.0), (3.2, 1.0)],
)
async def test_evaluator_confidence_clamp_boundaries(raw_conf, expected):
    draft = _EvalDraft(
        verdict=Verdict.MIXED, confidence=raw_conf, evidence=[], reasoning="r"
    )
    client = make_client(
        create_content=[_text_block("发现 https://x")], parse_output=draft
    )
    evl = await ClaudeEvaluatorAgent(client).evaluate(CLAIM)
    assert evl.confidence == expected
