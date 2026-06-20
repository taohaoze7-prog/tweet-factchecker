"""集成冒烟：mock + real 双链路，过 FastAPI app（真集成，非直调 orchestrator）。

供三线合并回 main 后一键验证。用法：

    python smoke.py                 # 仅 mock 链路（默认，无需 key）
    USE_REAL_AGENTS=1 ANTHROPIC_API_KEY=sk-... python smoke.py   # mock + real

退出码：0 全过；非 0 有失败。
- mock 链路始终跑，是每次合并的硬门槛。
- real 链路仅在 USE_REAL_AGENTS=1 且有 key 时跑；一旦启用，失败即非 0
  （三线全部落地后应通过；agent-layer 未实现时启用会如实报错）。
"""

from __future__ import annotations

import asyncio
import os
import sys

import httpx

from app import create_app
from contracts.models import FactCheckResult
from mocks import build_mock_orchestrator
from wiring import build_real_orchestrator

SAMPLE = {
    "tweet_id": "smoke-1",
    "text": "地球是圆的。月球绕地球转。",
    "author_handle": "@smoke",
}


async def _hit(app) -> FactCheckResult:
    """过 ASGI 打 POST /factcheck，校验响应符合契约。"""
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as c:
        health = await c.get("/health")
        assert health.status_code == 200, f"/health -> {health.status_code}"
        resp = await c.post("/factcheck", json=SAMPLE)
        assert resp.status_code == 200, f"/factcheck -> {resp.status_code}: {resp.text}"
        # 用契约模型反序列化 = 形状校验
        result = FactCheckResult.model_validate(resp.json())
        assert result.tweet_id == SAMPLE["tweet_id"]
        assert 0.0 <= result.overall_confidence <= 1.0
        return result


async def run_mock() -> None:
    app = create_app(build_mock_orchestrator())
    result = await _hit(app)
    print(
        f"  ✓ mock  : verdict={result.overall_verdict.value} "
        f"conf={result.overall_confidence:.2f} claims={len(result.claims)} "
        f"ms={result.processing_ms}"
    )


async def run_real() -> None:
    app = create_app(build_real_orchestrator())
    result = await _hit(app)
    print(
        f"  ✓ real  : verdict={result.overall_verdict.value} "
        f"conf={result.overall_confidence:.2f} claims={len(result.claims)} "
        f"models={result.model_versions}"
    )


async def main() -> int:
    print("集成冒烟（双链路）")
    failures: list[str] = []

    # ── mock 链路：硬门槛 ──
    try:
        await run_mock()
    except Exception as e:  # noqa: BLE001 — 冒烟脚本顶层兜底，原样上报
        failures.append(f"mock: {e!r}")
        print(f"  ✗ mock  : {e!r}")

    # ── real 链路：仅在显式启用时跑 ──
    real_enabled = os.getenv("USE_REAL_AGENTS") == "1" and bool(
        os.getenv("ANTHROPIC_API_KEY") or os.getenv("ANTHROPIC_AUTH_TOKEN")
    )
    if real_enabled:
        try:
            await run_real()
        except Exception as e:  # noqa: BLE001
            failures.append(f"real: {e!r}")
            print(f"  ✗ real  : {e!r}")
    else:
        print("  – real  : SKIP（设 USE_REAL_AGENTS=1 + ANTHROPIC_API_KEY 启用）")

    if failures:
        print(f"\n✗ 冒烟失败 {len(failures)} 项")
        return 1
    print("\n✓ 冒烟全过")
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
