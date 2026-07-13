"""
客户端诊断聚合端点

接收 avatarDiagnostics 上报的段间切换记录，存入内存环形缓冲 + JSONL 文件。
GET 返回聚合统计（P50/P95/命中率）。
"""
import json
import logging
import os
import time
from collections import deque
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/diag", tags=["diag"])

LOG_PATH = Path("/tmp/avatar_diag.jsonl")
LOG_PATH.parent.mkdir(parents=True, exist_ok=True)

# 内存环形缓冲（最近 1000 条）
BUFFER_SIZE = 1000
_buffer: deque = deque(maxlen=BUFFER_SIZE)


class SwitchRecordIn(BaseModel):
    url: str
    tsStart: float
    tsIdbLookupDone: float | None = None
    tsSrcSet: float | None = None
    tsCanplay: float | None = None
    tsError: float | None = None
    cacheHit: bool = False
    resolvedSrcKind: str = "unknown"
    loadingDurationMs: float | None = None
    totalSwitchDurationMs: float | None = None
    # 服务端打戳
    receivedAt: float | None = None
    ua: str | None = None


def _percentile(values: list[float], p: float) -> float:
    if not values:
        return 0.0
    sorted_v = sorted(values)
    idx = min(int(len(sorted_v) * p), len(sorted_v) - 1)
    return round(sorted_v[idx], 1)


@router.post("/avatar")
async def post_avatar_diag(record: SwitchRecordIn) -> dict:
    """接收客户端上报的段间切换诊断数据"""
    record.receivedAt = time.time()
    payload = record.model_dump()

    # 写入环形缓冲
    _buffer.append(payload)

    # 追加到 JSONL 文件（用于长期分析）
    try:
        with LOG_PATH.open("a", encoding="utf-8") as f:
            f.write(json.dumps(payload, ensure_ascii=False) + "\n")
    except OSError as e:
        logger.warning(f"写入 diag 日志失败: {e}")

    return {"status": "ok", "buffered": len(_buffer)}


@router.get("/avatar")
async def get_avatar_diag() -> dict:
    """返回最近 1000 条记录的聚合统计"""
    records = list(_buffer)
    if not records:
        return {
            "count": 0,
            "p50_loadingMs": 0,
            "p95_loadingMs": 0,
            "p50_totalMs": 0,
            "p95_totalMs": 0,
            "hitRate": 0,
            "srcKindDistribution": {},
            "recentErrors": 0,
        }

    loading_values = [
        r["loadingDurationMs"]
        for r in records
        if r.get("loadingDurationMs") is not None
    ]
    total_values = [
        r["totalSwitchDurationMs"]
        for r in records
        if r.get("totalSwitchDurationMs") is not None
    ]
    hits = sum(1 for r in records if r.get("cacheHit"))
    kind_dist: dict[str, int] = {}
    for r in records:
        kind = r.get("resolvedSrcKind", "unknown")
        kind_dist[kind] = kind_dist.get(kind, 0) + 1
    errors = sum(1 for r in records if r.get("tsError") is not None)

    return {
        "count": len(records),
        "p50_loadingMs": _percentile(loading_values, 0.5),
        "p95_loadingMs": _percentile(loading_values, 0.95),
        "p50_totalMs": _percentile(total_values, 0.5),
        "p95_totalMs": _percentile(total_values, 0.95),
        "hitRate": round(hits / len(records), 3),
        "srcKindDistribution": kind_dist,
        "recentErrors": errors,
        "logPath": str(LOG_PATH),
    }


@router.delete("/avatar")
async def clear_avatar_diag() -> dict:
    """清空环形缓冲（不清文件）"""
    n = len(_buffer)
    _buffer.clear()
    return {"cleared": n}