"""CriticAgent 真实实现（agent-layer worktree 填充）。

模型：claude-sonnet-4-6。独立上下文复核，扮演"魔鬼代言人"。
当前为骨架：抛 NotImplementedError，先用 mocks.MockCriticAgent 跑通管道。
"""

from __future__ import annotations

from contracts.models import Claim, Evaluation, Critique
from llm.client import ClaudeClient

MODEL = "claude-sonnet-4-6"


class ClaudeCriticAgent:
    """用 Claude Sonnet 复核初判：查证据缺口、来源偏见、逻辑跳步。"""

    def __init__(self, client: ClaudeClient) -> None:
        self._client = client

    async def critique(self, claim: Claim, evaluation: Evaluation) -> Critique:
        # TODO(agent-layer): 喂入 claim + evaluation（含证据），让 critic 决定 approve/调整。
        # 不认可时必须给 adjusted_verdict 与 concerns；认可时 concerns 可空。
        raise NotImplementedError("ClaudeCriticAgent.critique 待 agent-layer 实现")
