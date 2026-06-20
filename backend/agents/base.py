"""Agent 接口契约（Protocol）。

orchestrator 仅依赖这三个 Protocol —— 真实实现（claim.py/evaluator.py/critic.py）
与 mock 实现（mocks/）都满足同一签名，可互换注入。

**冻结点**：方法签名一旦定稿，agent-layer 与 engine-wiring 两个 worktree
都按此对齐；改签名 = 跨线协调，慎重。
"""

from __future__ import annotations

from typing import Optional, Protocol, runtime_checkable

from contracts.models import Claim, Evaluation, Critique


@runtime_checkable
class ClaimAgent(Protocol):
    """从推文正文抽取可核查断言。模型：claude-haiku-4-5（轻量、高频）。"""

    async def extract(self, text: str, lang: Optional[str] = None) -> list[Claim]:
        """返回断言列表；不可核查的句子标记 checkable=False。"""
        ...


@runtime_checkable
class EvaluatorAgent(Protocol):
    """为单条断言搜证并给出初判。模型：claude-sonnet-4-6。"""

    async def evaluate(self, claim: Claim) -> Evaluation:
        ...


@runtime_checkable
class CriticAgent(Protocol):
    """复核 Evaluator 的初判，质疑证据 / 偏见 / 跳步。模型：claude-sonnet-4-6。"""

    async def critique(self, claim: Claim, evaluation: Evaluation) -> Critique:
        ...
