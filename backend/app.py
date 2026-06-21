"""FastAPI 入口：POST /factcheck。

默认挂全 mock 编排器，三个 worktree 都能 `uvicorn app:app --reload` 起服务。
USE_REAL_AGENTS=1 时切真实 Claude 链路（接线见 wiring.py）。

create_app(orchestrator) 工厂：smoke.py / 测试可注入任意编排器（mock 或真实），
不依赖 import 时的环境变量——这是双链路冒烟的接缝。
"""

from __future__ import annotations

import os

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse

from cache import CachingChecker, Checker, ResultCache
from contracts.models import FactCheckRequest, FactCheckResult
from mocks import build_mock_orchestrator
from stream_events import ErrorEvent, to_sse
from wiring import build_real_orchestrator


def create_app(orchestrator: Checker) -> FastAPI:
    """用指定编排器组装 FastAPI app（任意满足 Checker 协议者，含缓存包装）。"""
    app = FastAPI(title="Tweet FactChecker", version="0.1.0")

    # 浏览器扩展 content script 跨域调用 → 放开 CORS（生产应收紧来源）。
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_methods=["POST", "OPTIONS"],
        allow_headers=["*"],
    )

    @app.get("/health")
    async def health() -> dict[str, str]:
        return {"status": "ok"}

    @app.post("/factcheck", response_model=FactCheckResult)
    async def factcheck(request: FactCheckRequest) -> FactCheckResult:
        """核查一条推文，返回完整结论（一次性）。"""
        return await orchestrator.check(request)

    @app.post("/factcheck/stream")
    async def factcheck_stream(request: FactCheckRequest) -> StreamingResponse:
        """流式核查：SSE 推 claims → claim×N → done，前端渐进渲染。"""

        async def gen():
            try:
                async for event in orchestrator.check_stream(request):
                    yield to_sse(event)
            except Exception as exc:  # noqa: BLE001 — 流内兜底，转 error 事件
                yield to_sse(ErrorEvent(message=f"{type(exc).__name__}: {exc}"))

        return StreamingResponse(
            gen(),
            media_type="text/event-stream",
            headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
        )

    return app


def get_orchestrator() -> Checker:
    """编排器工厂（外层套结果缓存）。

    USE_REAL_AGENTS=1 时切换到真实 Claude agent（接线见 wiring.py）。
    默认走全 mock，无需 API key 即可起服务联调。
    结果缓存只省重复推文的重复计算，不影响判定质量；TTL 由 CACHE_TTL_S 调（默认 1h）。
    """
    inner = build_real_orchestrator() if os.getenv("USE_REAL_AGENTS") == "1" else build_mock_orchestrator()
    ttl = float(os.getenv("CACHE_TTL_S", "3600"))
    return CachingChecker(inner, ResultCache(ttl_s=ttl))


# uvicorn app:app 入口（按 USE_REAL_AGENTS 选链路 + 结果缓存）。
app = create_app(get_orchestrator())
