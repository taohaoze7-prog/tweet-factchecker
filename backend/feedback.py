"""用户反馈采集：👍/👎 落 JSONL，作为离线调优 / 评测集的原料。

不碰冻结契约（contracts/models.py）——独立模型，附加传输面。
存「推文 → 我们的裁决 → 用户认为对/错」三件事，这是后续改提示词 / 攒 eval 集 /
调来源权重的原料。落盘为 append-only JSONL；将来上线换数据库时端点契约不变。
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, Field

from contracts.models import Verdict

FEEDBACK_PATH = Path(__file__).parent / "data" / "feedback.jsonl"


class Feedback(BaseModel):
    """一条用户反馈（扩展 → 后端）。"""

    tweet_id: str
    text: str = Field(..., description="推文原文，便于离线复盘")
    our_verdict: Verdict = Field(..., description="我们给出的整体裁决")
    our_confidence: float = Field(..., ge=0.0, le=1.0)
    rating: Literal["up", "down"] = Field(..., description="用户认为：up=对，down=错")
    models: dict[str, str] = Field(default_factory=dict)


def record_feedback(fb: Feedback) -> None:
    """追加一行 JSONL，附服务端时间戳。"""
    FEEDBACK_PATH.parent.mkdir(parents=True, exist_ok=True)
    entry = fb.model_dump(mode="json")
    entry["ts"] = datetime.now(timezone.utc).isoformat()
    with FEEDBACK_PATH.open("a", encoding="utf-8") as f:
        f.write(json.dumps(entry, ensure_ascii=False) + "\n")
