"""结构化输出助手（agent-layer 内部，私有）。

用官方推荐的 `messages.parse` + Pydantic 草稿模型拿结构化结果（DoD 要求，
不手撸 JSON 字符串匹配）。各 agent 拿到草稿后在代码侧组装契约对象
（强制写 id、clamp 概率），保证最终对象一定通过契约校验。

任何失败（网络、拒答、max_tokens 截断导致 parsed_output 为空）都返回 None ——
由各 agent 自行降级，绝不抛错阻断管道。
"""

from __future__ import annotations

from typing import Optional, Type, TypeVar

from pydantic import BaseModel

T = TypeVar("T", bound=BaseModel)


async def parse_structured(
    raw,
    *,
    model: str,
    system: str,
    user: str,
    schema: Type[T],
    max_tokens: int = 2048,
) -> Optional[T]:
    """用 messages.parse 让模型吐出 `schema` 形状的结构化结果。

    raw: anthropic.AsyncAnthropic 实例（来自 ClaudeClient.raw）。
    返回校验通过的 `schema` 实例；任何环节失败返回 None。
    """
    try:
        resp = await raw.messages.parse(
            model=model,
            max_tokens=max_tokens,
            system=system,
            messages=[{"role": "user", "content": user}],
            output_format=schema,
        )
    except Exception:
        return None
    return resp.parsed_output
