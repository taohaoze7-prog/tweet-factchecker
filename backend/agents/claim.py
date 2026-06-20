"""ClaimAgent 真实实现（agent-layer worktree 填充）。

模型：claude-haiku-4-5（抽取任务轻量、调用频繁）。

策略：让 Haiku 通过 structured outputs 返回「断言草稿」（只含 text/checkable），
id 由本文件按抽取顺序稳定生成（c1/c2…）。这样最终 Claim 一定满足契约：
- id 唯一稳定（代码生成，非模型生成）
- text 非空（过滤空串）
- checkable 为 bool

对照 mocks.MockClaimAgent 的输出形状，但用真实模型替换句号粗切逻辑。
"""

from __future__ import annotations

from typing import Optional

from pydantic import BaseModel, Field

from agents._structured import extract_structured
from contracts.models import Claim
from llm.client import ClaudeClient

MODEL = "claude-haiku-4-5"

_SYSTEM = """\
你是事实核查管道的「断言抽取器」。输入一条社交媒体推文，输出其中可核查的事实性断言。

规则：
1. 把复合句拆成独立的、自包含的单条断言（每条能脱离上下文被验证）。
2. checkable=true 仅用于客观、可被证据证实或证伪的事实性陈述
   （数据、事件、引述、因果主张）。
3. checkable=false 用于主观意见、预测、玩笑、反问、纯情绪表达。
4. text 用推文原文的语言，规范化为陈述句，去掉表情/话题标签噪声。
5. 没有任何可核查内容时返回空列表。
"""


class _ClaimDraft(BaseModel):
    """模型输出的单条断言草稿（不含 id）。"""

    text: str = Field(..., description="规范化后的断言陈述")
    checkable: bool = Field(..., description="是否为可核查的事实性断言")


class _ClaimList(BaseModel):
    """structured outputs 的顶层包裹。"""

    claims: list[_ClaimDraft] = Field(default_factory=list)


class ClaudeClaimAgent:
    """用 Claude Haiku 抽取断言。"""

    def __init__(self, client: ClaudeClient) -> None:
        self._client = client

    async def extract(self, text: str, lang: Optional[str] = None) -> list[Claim]:
        drafts = await self._extract_drafts(text, lang)

        claims = [
            Claim(id=f"c{i + 1}", text=d.text.strip(), checkable=d.checkable)
            for i, d in enumerate(drafts)
            if d.text and d.text.strip()
        ]

        # 兜底：模型未抽到任何断言时，把整条推文当作一条待核查断言，
        # 与 MockClaimAgent 行为一致，保证下游有内容可走。
        if not claims:
            return [Claim(id="c1", text=text.strip() or text, checkable=True)]
        return claims

    async def _extract_drafts(
        self, text: str, lang: Optional[str]
    ) -> list[_ClaimDraft]:
        hint = f"\n（推文语言提示：{lang}）" if lang else ""
        parsed = await extract_structured(
            self._client.raw,
            model=MODEL,
            system=_SYSTEM,
            user=f"推文：\n{text}{hint}",
            schema=_ClaimList,
            tool_name="record_claims",
            tool_description="登记从推文中抽取出的可核查断言列表。",
            max_tokens=1024,
        )
        return list(parsed.claims) if parsed is not None else []
