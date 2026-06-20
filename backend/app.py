"""FastAPI 入口：POST /factcheck。

默认挂载全 mock 编排器，三个 worktree 都能 `uvicorn app:app --reload` 起服务。
engine-wiring 接好真实 agent 后，把 build_mock_orchestrator() 换成真实组装即可。
"""

from __future__ import annotations

import os

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from contracts.models import FactCheckRequest, FactCheckResult
from mocks import build_mock_orchestrator
from orchestrator import Orchestrator

app = FastAPI(title="Tweet FactChecker", version="0.1.0")

# 浏览器扩展 content script 跨域调用 → 放开 CORS（生产应收紧来源）。
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["POST", "OPTIONS"],
    allow_headers=["*"],
)


def get_orchestrator() -> Orchestrator:
    """编排器工厂。

    USE_REAL_AGENTS=1 时切换到真实 Claude agent（engine-wiring 落地后实现）。
    """
    if os.getenv("USE_REAL_AGENTS") == "1":
        # TODO(engine-wiring): 组装 ClaudeClaimAgent / ClaudeEvaluatorAgent / ClaudeCriticAgent
        raise NotImplementedError("真实 agent 组装待 engine-wiring 实现")
    return build_mock_orchestrator()


_orchestrator = get_orchestrator()


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/factcheck", response_model=FactCheckResult)
async def factcheck(request: FactCheckRequest) -> FactCheckResult:
    """核查一条推文，返回完整结论。"""
    return await _orchestrator.check(request)
