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

from contracts.models import FactCheckRequest, FactCheckResult
from mocks import build_mock_orchestrator
from orchestrator import Orchestrator
from wiring import build_real_orchestrator


def create_app(orchestrator: Orchestrator) -> FastAPI:
    """用指定编排器组装 FastAPI app。"""
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
        """核查一条推文，返回完整结论。"""
        return await orchestrator.check(request)

    return app


def get_orchestrator() -> Orchestrator:
    """编排器工厂。

    USE_REAL_AGENTS=1 时切换到真实 Claude agent（接线见 wiring.py）。
    默认走全 mock，无需 API key 即可起服务联调。
    """
    if os.getenv("USE_REAL_AGENTS") == "1":
        return build_real_orchestrator()
    return build_mock_orchestrator()


# uvicorn app:app 入口（按 USE_REAL_AGENTS 选链路）。
app = create_app(get_orchestrator())
