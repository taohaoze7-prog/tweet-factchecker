"""结构化输出助手（agent-layer 内部，私有）。

anthropic 0.75.0 还没有 messages.parse / output_format，这里用「强制工具调用」实现
跨版本稳定的结构化输出：把 Pydantic 草稿模型的 JSON Schema 当作工具的 input_schema，
tool_choice 强制模型只能调用它，再用同一模型校验 tool_use.input。

任何失败（网络、拒答、schema 不匹配）都返回 None —— 由各 agent 自行降级，绝不抛错。
"""

from __future__ import annotations

from typing import Optional, Type, TypeVar

from pydantic import BaseModel

T = TypeVar("T", bound=BaseModel)


async def extract_structured(
    raw,
    *,
    model: str,
    system: str,
    user: str,
    schema: Type[T],
    tool_name: str,
    tool_description: str,
    max_tokens: int = 2048,
) -> Optional[T]:
    """用强制工具调用让模型吐出 `schema` 形状的结构化结果。

    raw: anthropic.AsyncAnthropic 实例（来自 ClaudeClient.raw）。
    返回校验通过的 `schema` 实例；任何环节失败返回 None。
    """
    tool = {
        "name": tool_name,
        "description": tool_description,
        "input_schema": schema.model_json_schema(),
    }
    try:
        resp = await raw.messages.create(
            model=model,
            max_tokens=max_tokens,
            system=system,
            messages=[{"role": "user", "content": user}],
            tools=[tool],
            tool_choice={"type": "tool", "name": tool_name},
        )
    except Exception:
        return None

    for block in resp.content:
        if getattr(block, "type", None) == "tool_use" and block.name == tool_name:
            try:
                return schema.model_validate(block.input)
            except Exception:
                return None
    return None
