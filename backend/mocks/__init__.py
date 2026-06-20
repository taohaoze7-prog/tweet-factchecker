"""Mock agent 实现——返回固定数据，不调用 Claude。

让三个 worktree 在真实 agent 落地前就能跑通完整管道、联调契约。
"""

from mocks.mock_agents import (
    MockClaimAgent,
    MockEvaluatorAgent,
    MockCriticAgent,
    build_mock_orchestrator,
)

__all__ = [
    "MockClaimAgent",
    "MockEvaluatorAgent",
    "MockCriticAgent",
    "build_mock_orchestrator",
]
