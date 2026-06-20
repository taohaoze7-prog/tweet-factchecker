"""Claude 异步客户端封装。

统一三个 agent 的调用入口：从环境变量读 ANTHROPIC_API_KEY，
默认 adaptive thinking，复杂任务自动开启。各 agent 自带模型 ID（见 agents/*.py）。

参考：官方 `anthropic` Python SDK（claude-api skill）。
模型默认值不在此硬编码——调用方（agent）显式传 model。
"""

from __future__ import annotations

from typing import Any, Optional

import anthropic


class ClaudeClient:
    """对 anthropic.AsyncAnthropic 的薄封装。

    - 凭证从环境（ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN / ant profile）解析。
    - structured 输出用 messages.parse + Pydantic（见各 agent 实现）。
    """

    def __init__(self, api_key: Optional[str] = None) -> None:
        self._client = (
            anthropic.AsyncAnthropic(api_key=api_key)
            if api_key
            else anthropic.AsyncAnthropic()
        )

    @property
    def raw(self) -> anthropic.AsyncAnthropic:
        """底层 SDK 客户端（agent 需要 messages.parse / web_search 时直接用）。"""
        return self._client

    async def complete_text(
        self,
        *,
        model: str,
        system: str,
        user: str,
        max_tokens: int = 4096,
        **kwargs: Any,
    ) -> str:
        """便捷方法：单轮文本补全，返回首个 text block。

        复杂结构化输出请走 self.raw.messages.parse(...)，不要用本方法。
        """
        resp = await self._client.messages.create(
            model=model,
            max_tokens=max_tokens,
            thinking={"type": "adaptive"},
            system=system,
            messages=[{"role": "user", "content": user}],
            **kwargs,
        )
        for block in resp.content:
            if block.type == "text":
                return block.text
        return ""
