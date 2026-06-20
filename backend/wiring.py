"""真实编排器组装（engine-wiring worktree 负责）。

把共享的 ClaudeClient 注入三个真实 agent，再装进 Orchestrator——
与 mocks.build_mock_orchestrator 同构，仅替换被注入的 agent 实现。

注意：本模块只负责"接线"。三个 agent 的内部实现（提示词 / structured
outputs / web_search）属于 agent-layer worktree；其方法当前可能仍抛
NotImplementedError，待 agent-layer 落地后整条链路即自动可用。
"""

from __future__ import annotations

from typing import Optional

from agents.claim import ClaudeClaimAgent, MODEL as CLAIM_MODEL
from agents.evaluator import ClaudeEvaluatorAgent, MODEL as EVALUATOR_MODEL
from agents.critic import ClaudeCriticAgent, MODEL as CRITIC_MODEL
from llm.client import ClaudeClient
from orchestrator import Orchestrator


def build_real_orchestrator(client: Optional[ClaudeClient] = None) -> Orchestrator:
    """组装一个调用真实 Claude 的编排器。

    三个 agent 共用同一个 ClaudeClient（连接池 / 凭证复用）。
    model_versions 取各 agent 自带的 MODEL 常量，写入响应供审计。
    """
    client = client or ClaudeClient()
    return Orchestrator(
        claim_agent=ClaudeClaimAgent(client),
        evaluator=ClaudeEvaluatorAgent(client),
        critic=ClaudeCriticAgent(client),
        model_versions={
            "claim": CLAIM_MODEL,
            "evaluator": EVALUATOR_MODEL,
            "critic": CRITIC_MODEL,
        },
    )
