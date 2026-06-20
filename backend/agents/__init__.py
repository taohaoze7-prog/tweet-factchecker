"""Agent 层契约（agent-layer worktree 负责实现）。

三个 agent 的接口（Protocol）冻结在 base.py，orchestrator 只依赖这些 Protocol，
不关心背后是真 Claude 调用还是 mock。
"""

from agents.base import ClaimAgent, EvaluatorAgent, CriticAgent

__all__ = ["ClaimAgent", "EvaluatorAgent", "CriticAgent"]
