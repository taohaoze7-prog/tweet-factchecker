"""CriticAgent 真实实现（agent-layer worktree 填充）。

模型：claude-sonnet-4-6。独立上下文复核，扮演「魔鬼代言人」。

策略：把 claim + evaluation（含证据）喂给 Sonnet，用 structured outputs 返回
「复核草稿」（approved + 可选 adjusted_* + concerns）。claim_id 由本文件强制写入，
adjusted_confidence 若存在则 clamp 到 [0,1]，保证最终 Critique 通过契约校验。

约定：approved=False 时强制补一个 adjusted_verdict（缺失则回落到原判定），
concerns 至少给一条，避免「不认可却说不出问题」的空壳复核。
"""

from __future__ import annotations

from typing import Optional

from pydantic import BaseModel, Field

from agents._structured import extract_structured
from contracts.models import Claim, Critique, Evaluation, Verdict
from llm.client import ClaudeClient

MODEL = "claude-sonnet-4-6"

_SYSTEM = """\
你是事实核查管道的「复核官」，独立复核评估员的初判，专挑漏洞。

审查维度：
1. 证据是否充分、是否单一来源、是否存在来源偏见或利益冲突。
2. verdict 与证据是否匹配，是否过度自信或过度保守。
3. 推理是否有逻辑跳步、是否把相关当因果、是否忽略反例。

输出：
- approved=true：认可初判，concerns 可为空（也可给提醒）。
- approved=false：必须给 adjusted_verdict（修正判定），并在 concerns 列出具体质疑点。
- adjusted_confidence 可选，∈[0,1]。
- concerns 用断言原文的语言书写。
"""


class _CritiqueDraft(BaseModel):
    approved: bool
    adjusted_verdict: Optional[Verdict] = None
    adjusted_confidence: Optional[float] = None
    concerns: list[str] = Field(default_factory=list)


def _clamp(x: float) -> float:
    if x != x:  # NaN
        return 0.0
    return max(0.0, min(1.0, float(x)))


def _format_evaluation(evaluation: Evaluation) -> str:
    lines = [
        f"初判 verdict：{evaluation.verdict.value}",
        f"置信度 confidence：{evaluation.confidence}",
        f"理由 reasoning：{evaluation.reasoning}",
        "证据 evidence：",
    ]
    if evaluation.evidence:
        for i, e in enumerate(evaluation.evidence, 1):
            title = e.title or "（无标题）"
            lines.append(
                f"  [{i}] ({e.stance.value}, score={e.score}) {title} — {e.source_url}\n"
                f"      摘录：{e.snippet}"
            )
    else:
        lines.append("  （无证据）")
    return "\n".join(lines)


class ClaudeCriticAgent:
    """用 Claude Sonnet 复核初判：查证据缺口、来源偏见、逻辑跳步。"""

    def __init__(self, client: ClaudeClient) -> None:
        self._client = client

    async def critique(self, claim: Claim, evaluation: Evaluation) -> Critique:
        draft = await self._review(claim, evaluation)
        if draft is None:
            # 复核失败时保守认可初判，并标注复核缺失，绝不阻断管道。
            return Critique(
                claim_id=claim.id,
                approved=True,
                adjusted_verdict=None,
                adjusted_confidence=None,
                concerns=["（复核失败）未能完成独立复核，沿用评估员初判。"],
            )

        approved = draft.approved
        adjusted_verdict = draft.adjusted_verdict
        concerns = [c for c in draft.concerns if c and c.strip()]

        # 不认可却没给修正判定 → 回落到原判定，并保证至少一条质疑。
        if not approved:
            if adjusted_verdict is None:
                adjusted_verdict = evaluation.verdict
            if not concerns:
                concerns = ["复核不认可初判，但未给出具体质疑点。"]
        else:
            # 认可时修正判定无意义，清空避免下游误用。
            adjusted_verdict = None

        adjusted_confidence = (
            _clamp(draft.adjusted_confidence)
            if (not approved and draft.adjusted_confidence is not None)
            else None
        )

        return Critique(
            claim_id=claim.id,
            approved=approved,
            adjusted_verdict=adjusted_verdict,
            adjusted_confidence=adjusted_confidence,
            concerns=concerns,
        )

    async def _review(
        self, claim: Claim, evaluation: Evaluation
    ) -> Optional[_CritiqueDraft]:
        user = (
            f"断言：\n{claim.text}\n\n"
            f"评估员的初判：\n{_format_evaluation(evaluation)}"
        )
        return await extract_structured(
            self._client.raw,
            model=MODEL,
            system=_SYSTEM,
            user=user,
            schema=_CritiqueDraft,
            tool_name="record_critique",
            tool_description="登记对评估员初判的独立复核结论。",
            max_tokens=2048,
        )
