"""
语音识别 REST API

端点：
- POST /api/asr/transcribe  接收浏览器 MediaRecorder 产出的 base64 音频，返回转写文本
"""
import logging
import time
from typing import Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from server.services.asr_engine import AsrEngine, AsrError

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/asr", tags=["asr"])


class TranscribeRequest(BaseModel):
    """转写请求"""
    audio: str = Field(..., description="base64 编码的音频（来自 MediaRecorder）")
    format: str = Field(default="webm", description="音频格式: webm | mp4 | wav | ogg")
    language: str = Field(default="zh", description="语种标识，默认 zh")


class TranscribeResponse(BaseModel):
    """转写响应"""
    text: str
    duration_ms: int = Field(default=0, description="服务端处理耗时（毫秒）")


# 全局 ASR 引擎（懒加载，单例复用 httpx 连接）
_engine: Optional[AsrEngine] = None


def _get_engine() -> AsrEngine:
    """懒加载 AsrEngine（避免模块导入即建立连接）"""
    global _engine
    if _engine is None:
        _engine = AsrEngine()
    return _engine


@router.post("/transcribe", response_model=TranscribeResponse)
async def transcribe(req: TranscribeRequest):
    """
    语音转写端点

    接收浏览器 MediaRecorder 产出的音频（base64），调用 DashScope
    qwen3-asr-flash 模型转写为文本，返回给前端填入输入框。

    错误码：
      400 - 音频为空 / 格式不支持
      413 - 音频超过 max_audio_seconds 上限
      502 - DashScope 调用失败
      504 - 调用超时
    """
    if not req.audio or not req.audio.strip():
        raise HTTPException(status_code=400, detail="audio 不能为空")

    engine = _get_engine()

    t0 = time.monotonic()
    try:
        text = await engine.transcribe(
            audio_base64=req.audio.strip(),
            format=req.format,
            language=req.language,
        )
        duration_ms = int((time.monotonic() - t0) * 1000)
        return TranscribeResponse(text=text, duration_ms=duration_ms)

    except AsrError as e:
        logger.warning(f"ASR 转写失败: {e}")

        # 鉴权失败
        if e.status_code in (401, 403):
            raise HTTPException(status_code=502, detail=f"ASR 鉴权失败: {e}")

        # 超时
        if "超时" in str(e):
            raise HTTPException(status_code=504, detail=str(e))

        # 客户端参数错误（格式不支持等）
        if "格式" in str(e) or "为空" in str(e) or "API Key 未配置" in str(e):
            raise HTTPException(status_code=400, detail=str(e))

        # 其他服务端错误
        raise HTTPException(status_code=502, detail=f"ASR 调用失败: {e}")


@router.get("/health")
async def asr_health():
    """ASR 健康检查：返回当前配置信息"""
    engine = _get_engine()
    return {
        "available": bool(engine.api_key),
        "model": engine.model,
        "endpoint": engine.endpoint,
        "max_audio_seconds": engine.max_audio_seconds,
    }