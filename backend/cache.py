"""结果缓存：同一推文短期内复用核查结论。

不重跑管道、**不碰 agent 判定逻辑** → 对判定质量零影响，只省重复推文的总延迟
（爆款推文多人/多次核查直接命中）。键为推文文本+语言的哈希，带 TTL（事实会随时间
变化，不做永久缓存）。

注意：进程内内存缓存，适合单 worker。多 worker / 多实例需换共享缓存（Redis 等）——见下方 TODO。
"""

from __future__ import annotations

import hashlib
import time
from collections import OrderedDict
from typing import AsyncIterator, Optional, Protocol

from contracts.models import FactCheckRequest, FactCheckResult
from stream_events import DoneEvent, StreamEvent


class Checker(Protocol):
    """凡有 check + check_stream 者皆可被缓存包装（Orchestrator 即满足）。"""

    async def check(self, request: FactCheckRequest) -> FactCheckResult: ...

    def check_stream(
        self, request: FactCheckRequest
    ) -> AsyncIterator[StreamEvent]: ...


class ResultCache:
    """带 TTL 的有界内存缓存（LRU 淘汰）。键 = 规范化文本 + 语言。"""

    def __init__(self, ttl_s: float = 3600.0, max_entries: int = 512) -> None:
        self._ttl = ttl_s
        self._max = max_entries
        # key -> (存入时刻, 结果)
        self._store: "OrderedDict[str, tuple[float, FactCheckResult]]" = OrderedDict()

    @staticmethod
    def _key(request: FactCheckRequest) -> str:
        norm = (request.text or "").strip()
        lang = request.lang or ""
        return hashlib.sha256(f"{lang}\x00{norm}".encode("utf-8")).hexdigest()

    def get(self, request: FactCheckRequest) -> Optional[FactCheckResult]:
        key = self._key(request)
        hit = self._store.get(key)
        if hit is None:
            return None
        stored_at, result = hit
        if time.time() - stored_at > self._ttl:
            self._store.pop(key, None)  # 过期淘汰
            return None
        self._store.move_to_end(key)  # LRU：命中即刷新
        return result

    def put(self, request: FactCheckRequest, result: FactCheckResult) -> None:
        key = self._key(request)
        self._store[key] = (time.time(), result)
        self._store.move_to_end(key)
        while len(self._store) > self._max:
            self._store.popitem(last=False)  # 淘汰最久未用


class CachingChecker:
    """给任意 Checker 套结果缓存。命中即返回（回填当前请求的 tweet_id 与真实耗时）。"""

    def __init__(self, inner: Checker, cache: Optional[ResultCache] = None) -> None:
        self._inner = inner
        self._cache = cache or ResultCache()

    async def check(self, request: FactCheckRequest) -> FactCheckResult:
        started = time.monotonic()
        cached = self._cache.get(request)
        if cached is not None:
            # 不可变更新：缓存结论按内容复用，但 tweet_id / 耗时回填为本次请求实际值，
            # 避免把别条推文（同文本转推）的 id 或旧耗时带出。
            hit_ms = int((time.monotonic() - started) * 1000)
            return cached.model_copy(
                update={"tweet_id": request.tweet_id, "processing_ms": hit_ms}
            )

        result = await self._inner.check(request)
        self._cache.put(request, result)
        return result

    async def check_stream(
        self, request: FactCheckRequest
    ) -> AsyncIterator[StreamEvent]:
        """流式 + 缓存：命中直接推一个 done（无需流式），未命中边流边在末尾入缓存。"""
        cached = self._cache.get(request)
        if cached is not None:
            started = time.monotonic()
            hit_ms = int((time.monotonic() - started) * 1000)
            yield DoneEvent(
                result=cached.model_copy(
                    update={"tweet_id": request.tweet_id, "processing_ms": hit_ms}
                )
            )
            return

        final: Optional[FactCheckResult] = None
        async for event in self._inner.check_stream(request):
            if isinstance(event, DoneEvent):
                final = event.result
            yield event
        if final is not None:
            self._cache.put(request, final)

    # TODO(scale)：多 worker 部署时把 ResultCache 换成 Redis 等共享后端，
    # CachingChecker 逻辑不变。
