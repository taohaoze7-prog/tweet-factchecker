"""流式进度事件 + SSE 序列化。

新增传输面，**不改冻结契约**（contracts/models.py 原样复用）。
事件序列：claims（断言骨架）→ claim×N（逐条完成，完成顺序）→ done（最终聚合）。
失败时 error。前端按 claim_id 把 claim 事件填进骨架对应行。
"""

from __future__ import annotations

from typing import Literal, Union

from pydantic import BaseModel

from contracts.models import Claim, ClaimResult, FactCheckResult


class ClaimsEvent(BaseModel):
    """断言抽取完成，给前端渲染骨架行（仅可核查的断言，与最终 result.claims 一致）。"""

    type: Literal["claims"] = "claims"
    claims: list[Claim]


class ClaimDoneEvent(BaseModel):
    """单条断言核查完成（evaluator+critic+收敛），前端填进对应行。"""

    type: Literal["claim"] = "claim"
    result: ClaimResult


class DoneEvent(BaseModel):
    """全部完成，携带最终聚合结论（与 /factcheck 返回的 FactCheckResult 同形）。"""

    type: Literal["done"] = "done"
    result: FactCheckResult


class ErrorEvent(BaseModel):
    type: Literal["error"] = "error"
    message: str


StreamEvent = Union[ClaimsEvent, ClaimDoneEvent, DoneEvent, ErrorEvent]


def to_sse(event: BaseModel) -> str:
    """序列化为一条 SSE 记录：event:<type>\\ndata:<json>\\n\\n。"""
    name = getattr(event, "type", "message")
    return f"event: {name}\ndata: {event.model_dump_json()}\n\n"
