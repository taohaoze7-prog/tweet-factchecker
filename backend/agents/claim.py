"""ClaimAgent 真实实现（agent-layer worktree 填充）。

模型：claude-haiku-4-5（抽取任务轻量、调用频繁）。
当前为骨架：抛 NotImplementedError，先用 mocks.MockClaimAgent 跑通管道。
"""

from __future__ import annotations

from typing import Optional

from contracts.models import Claim
from llm.client import ClaudeClient

MODEL = "claude-haiku-4-5"


class ClaudeClaimAgent:
    """用 Claude Haiku 抽取断言。"""

    def __init__(self, client: ClaudeClient) -> None:
        self._client = client

    async def extract(self, text: str, lang: Optional[str] = None) -> list[Claim]:
        # TODO(agent-layer): 用 structured outputs 让 Haiku 返回 Claim[] 的 JSON。
        # 提示词要点：拆分复合句、剔除主观/预测/玩笑（checkable=False）、生成稳定 id。
        raise NotImplementedError("ClaudeClaimAgent.extract 待 agent-layer 实现")
