"""核心数据契约（Pydantic v2）。

数据流：
    推文 (FactCheckRequest)
      └─ ClaimAgent     → list[Claim]            抽取可核查断言
           └─ EvaluatorAgent → Evaluation         找证据 + 初判
                └─ CriticAgent   → Critique         质疑 / 复核 / 调整
      ⇒ 组装为 ClaimResult[]  ⇒  FactCheckResult  ⇒  浏览器浮层

约定：
- 所有时间字段用 UTC ISO-8601 字符串。
- confidence ∈ [0.0, 1.0]。
- id 由抽取方（ClaimAgent）生成，全流程保持稳定。
"""

from __future__ import annotations

from enum import Enum
from typing import Optional

from pydantic import BaseModel, Field


# ─────────────────────────── 枚举 ───────────────────────────

class Verdict(str, Enum):
    """对单条断言或整体的判定结论。"""

    TRUE = "true"
    MOSTLY_TRUE = "mostly_true"
    MIXED = "mixed"
    MOSTLY_FALSE = "mostly_false"
    FALSE = "false"
    UNVERIFIABLE = "unverifiable"  # 无足够证据，或属主观/预测性表述


class Stance(str, Enum):
    """单条证据相对于断言的立场。"""

    SUPPORTS = "supports"
    REFUTES = "refutes"
    NEUTRAL = "neutral"


# ─────────────────────── 入口契约（extension ↔ backend）───────────────────────

class FactCheckRequest(BaseModel):
    """浏览器扩展 → 后端：一条待核查的推文。

    HTTP: POST /factcheck
    """

    tweet_id: str = Field(..., description="推文唯一 ID（平台原生 ID）")
    text: str = Field(..., min_length=1, description="推文正文")
    author_handle: Optional[str] = Field(None, description="作者 @handle，可选")
    url: Optional[str] = Field(None, description="推文链接，可选")
    lang: Optional[str] = Field(None, description="ISO-639-1 语言码，缺省后端自动判定")


# ─────────────────────── 管道内部契约（orchestrator ↔ agents）───────────────────────

class Claim(BaseModel):
    """ClaimAgent 从推文中抽取出的一条断言。"""

    id: str = Field(..., description="断言稳定 ID，由 ClaimAgent 生成（如 c1/c2）")
    text: str = Field(..., min_length=1, description="断言的规范化陈述")
    checkable: bool = Field(
        ..., description="是否为可核查的事实性断言（False=主观/预测/玩笑，跳过评估）"
    )


class Evidence(BaseModel):
    """EvaluatorAgent 为某条断言找到的一条证据。"""

    source_url: str = Field(..., description="证据来源链接")
    title: Optional[str] = Field(None, description="来源标题")
    snippet: str = Field(..., description="支撑判断的关键摘录")
    stance: Stance = Field(..., description="该证据相对断言的立场")
    score: float = Field(
        0.5, ge=0.0, le=1.0, description="来源可信度 / 相关度权重"
    )


class Evaluation(BaseModel):
    """EvaluatorAgent 对单条断言的初步判定。"""

    claim_id: str = Field(..., description="对应 Claim.id")
    verdict: Verdict
    confidence: float = Field(..., ge=0.0, le=1.0)
    evidence: list[Evidence] = Field(default_factory=list)
    reasoning: str = Field(..., description="判定理由（链路可追溯）")


class Critique(BaseModel):
    """CriticAgent 对一条 Evaluation 的复核结果。

    approved=True 表示认可初判；否则给出 adjusted_* 覆盖值。
    """

    claim_id: str = Field(..., description="对应 Claim.id")
    approved: bool = Field(..., description="是否认可 Evaluator 的初判")
    adjusted_verdict: Optional[Verdict] = Field(
        None, description="若不认可，给出修正后的判定"
    )
    adjusted_confidence: Optional[float] = Field(None, ge=0.0, le=1.0)
    concerns: list[str] = Field(
        default_factory=list, description="质疑点 / 证据缺口 / 偏见提示"
    )


# ─────────────────────── 出口契约（backend ↔ extension）───────────────────────

class ClaimResult(BaseModel):
    """单条断言走完 claim→evaluator→critic 后的合并结果。

    final_verdict / final_confidence 由 orchestrator 依据 Critique 收敛得出
    （critic 不认可时采用 adjusted_*，否则沿用 evaluation 值）。
    """

    claim: Claim
    evaluation: Evaluation
    critique: Critique
    final_verdict: Verdict
    final_confidence: float = Field(..., ge=0.0, le=1.0)


class FactCheckResult(BaseModel):
    """后端 → 浏览器扩展：一条推文的完整核查结论。

    HTTP: POST /factcheck 的响应体。
    """

    tweet_id: str
    overall_verdict: Verdict = Field(..., description="整体判定（聚合各 claim）")
    overall_confidence: float = Field(..., ge=0.0, le=1.0)
    summary: str = Field(..., description="一句话结论，用于浮层标题")
    claims: list[ClaimResult] = Field(default_factory=list)
    processing_ms: int = Field(0, ge=0, description="后端处理耗时（毫秒）")
    model_versions: dict[str, str] = Field(
        default_factory=dict,
        description="各 agent 使用的模型 ID，便于审计（如 {'claim': 'claude-haiku-4-5'}）",
    )
