"""EvaluatorAgent 真实实现（agent-layer worktree 填充）。

模型：claude-sonnet-4-6 + web_search 工具。
当前为骨架：抛 NotImplementedError，先用 mocks.MockEvaluatorAgent 跑通管道。
"""

from __future__ import annotations

from contracts.models import Claim, Evaluation  # noqa: F401  (Evaluation: 实现时返回值用)
from llm.client import ClaudeClient

MODEL = "claude-sonnet-4-6"


class ClaudeEvaluatorAgent:
    """用 Claude Sonnet + 联网搜证，对断言初判。"""

    def __init__(self, client: ClaudeClient) -> None:
        self._client = client

    async def evaluate(self, claim: Claim) -> Evaluation:
        # TODO(agent-layer): web_search 收集证据 → 按 stance 归类 → 给 verdict+confidence。
        # 每条 Evidence 必须带 source_url，reasoning 要可追溯到证据。
        raise NotImplementedError("ClaudeEvaluatorAgent.evaluate 待 agent-layer 实现")
