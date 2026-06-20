"""EvaluatorAgent 真实实现（agent-layer worktree 填充）。

模型：claude-sonnet-4-6 + web_search 服务端工具（web_search_20260209，
Sonnet 4.6 支持动态过滤变体）。

策略：两段式（强制输出工具无法与服务端 web_search 共存于同一次调用）。
1. 搜证：messages.create 挂 web_search，让 Sonnet 联网并简述发现 + 列出来源 URL。
2. 结构化：用强制工具调用把发现整理成「评估草稿」
   （verdict/confidence/evidence/reasoning）。

claim_id 由本文件强制写入（= 传入 claim.id），confidence/score 在代码侧 clamp 到
[0,1]，保证最终 Evaluation/Evidence 一定通过契约的 ge/le 校验。
搜索受限或拒答时降级为「无足够证据」的 UNVERIFIABLE 初判，绝不抛错阻断管道。
"""

from __future__ import annotations

from typing import Optional

from pydantic import BaseModel, Field

from agents._structured import extract_structured
from contracts.models import Claim, Evaluation, Evidence, Stance, Verdict
from llm.client import ClaudeClient

MODEL = "claude-sonnet-4-6"
_WEB_SEARCH_TOOL = {"type": "web_search_20260209", "name": "web_search", "max_uses": 5}

_RESEARCH_SYSTEM = """\
你是事实核查管道的「搜证员」。给定一条可核查断言，用 web_search 联网搜集权威证据。

要求：
1. 至少检索一次；优先一手来源、权威媒体、官方数据，注意交叉验证、避免单一来源。
2. 用断言原文的语言，简要复述你找到的关键事实，并逐条标注来源 URL。
3. 标明每条证据是支持（supports）、反驳（refutes）还是中立/无关（neutral）。
4. 若检索不到可靠证据，明确说明「证据不足」。
"""

_STRUCTURE_SYSTEM = """\
你是事实核查管道的「评估整理员」。基于已给出的搜证记录，对断言给出结构化初判。

要求：
1. 每条 evidence 必须带搜证记录里出现过的真实 source_url，snippet 为支撑判断的关键摘录，
   stance 取 supports / refutes / neutral，score∈[0,1] 表示来源可信度×相关度。
2. verdict 从 true / mostly_true / mixed / mostly_false / false / unverifiable 中选一个，
   confidence∈[0,1] 反映证据强度与一致性。
3. 证据不足、属预测或主观时，verdict=unverifiable 且 confidence 偏低、evidence 可为空。
4. reasoning 必须可追溯到所列证据，用断言原文的语言书写，不要编造来源。
"""


class _EvidenceDraft(BaseModel):
    source_url: str
    title: Optional[str] = None
    snippet: str
    stance: Stance
    score: float = Field(0.5, description="来源可信度×相关度，0~1")


class _EvalDraft(BaseModel):
    verdict: Verdict
    confidence: float = Field(..., description="判定置信度，0~1")
    evidence: list[_EvidenceDraft] = Field(default_factory=list)
    reasoning: str


def _clamp(x: float) -> float:
    """把模型给的概率夹到 [0,1]，防止越界触发契约校验失败。"""
    if x != x:  # NaN
        return 0.0
    return max(0.0, min(1.0, float(x)))


class ClaudeEvaluatorAgent:
    """用 Claude Sonnet + 联网搜证，对断言初判。"""

    def __init__(self, client: ClaudeClient) -> None:
        self._client = client

    async def evaluate(self, claim: Claim) -> Evaluation:
        research = await self._gather(claim)
        if not research:
            return self._unverifiable(claim, "证据检索失败或无可靠来源，暂判为无法核实。")

        draft = await self._structure(claim, research)
        if draft is None:
            return self._unverifiable(claim, "证据整理失败，暂判为无法核实。")

        evidence = [
            Evidence(
                source_url=e.source_url,
                title=e.title,
                snippet=e.snippet,
                stance=e.stance,
                score=_clamp(e.score),
            )
            for e in draft.evidence
            if e.source_url and e.snippet
        ]
        return Evaluation(
            claim_id=claim.id,  # 强制对齐，绝不信任模型自填
            verdict=draft.verdict,
            confidence=_clamp(draft.confidence),
            evidence=evidence,
            reasoning=draft.reasoning or "（评估员未给出理由）",
        )

    async def _gather(self, claim: Claim) -> Optional[str]:
        """第一段：联网搜证，返回带 URL 的发现摘要文本。"""
        try:
            resp = await self._client.raw.messages.create(
                model=MODEL,
                max_tokens=4096,
                system=_RESEARCH_SYSTEM,
                messages=[
                    {
                        "role": "user",
                        "content": f"待核查断言：\n{claim.text}\n\n"
                        "请联网搜证，并用文字复述发现、逐条标注来源 URL。",
                    }
                ],
                tools=[_WEB_SEARCH_TOOL],
            )
        except Exception:
            return None

        parts = [
            block.text
            for block in resp.content
            if getattr(block, "type", None) == "text" and getattr(block, "text", "")
        ]
        summary = "\n".join(parts).strip()
        return summary or None

    async def _structure(self, claim: Claim, research: str) -> Optional[_EvalDraft]:
        """第二段：把搜证摘要整理成结构化评估草稿。"""
        return await extract_structured(
            self._client.raw,
            model=MODEL,
            system=_STRUCTURE_SYSTEM,
            user=f"待核查断言：\n{claim.text}\n\n搜证记录：\n{research}",
            schema=_EvalDraft,
            tool_name="record_evaluation",
            tool_description="基于搜证记录登记对断言的结构化初判。",
            max_tokens=2048,
        )

    @staticmethod
    def _unverifiable(claim: Claim, reason: str) -> Evaluation:
        return Evaluation(
            claim_id=claim.id,
            verdict=Verdict.UNVERIFIABLE,
            confidence=0.0,
            evidence=[],
            reasoning=reason,
        )
