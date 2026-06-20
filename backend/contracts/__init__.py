"""共享契约层（contracts）——三个 worktree 的命脉。

frontend / agent-layer / engine-wiring 全部依赖这里定义的数据形状。
**冻结后不要随意改动**；任何改动都会同时影响三条并行开发线。
"""

from contracts.models import (
    Stance,
    Verdict,
    FactCheckRequest,
    Claim,
    Evidence,
    Evaluation,
    Critique,
    ClaimResult,
    FactCheckResult,
)

__all__ = [
    "Stance",
    "Verdict",
    "FactCheckRequest",
    "Claim",
    "Evidence",
    "Evaluation",
    "Critique",
    "ClaimResult",
    "FactCheckResult",
]
