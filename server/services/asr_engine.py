"""
语音识别引擎：调用 DashScope qwen3-asr-flash（OpenAI 兼容模式）
输入：本地音频 base64（来自浏览器 MediaRecorder 产出的 webm/opus 或 mp4）
输出：转写文本
"""
import asyncio
import base64
import logging
from typing import Optional

import httpx

from server.config import get_config

logger = logging.getLogger(__name__)


class AsrError(Exception):
    """ASR 调用错误"""
    def __init__(self, message: str, status_code: Optional[int] = None):
        super().__init__(message)
        self.status_code = status_code


# 支持的音频格式 → MIME（与 MediaRecorder 实际产出对齐）
SUPPORTED_FORMATS = {
    "webm": "audio/webm",
    "mp4": "audio/mp4",
    "wav": "audio/wav",
    "ogg": "audio/ogg",
}


def _to_data_url(audio_base64: str, mime: str) -> str:
    """
    将裸 base64 包装为 DashScope 要求的 Data URL 格式。

    DashScope OpenAI 兼容模式的 input_audio.data 字段不接受纯 base64 字符串，
    必须使用 Data URL 格式：data:<mediatype>;base64,<data>
    """
    return f"data:{mime};base64,{audio_base64}"


class AsrEngine:
    """DashScope 语音识别（ASR）引擎"""

    def __init__(self):
        cfg = get_config()
        self.endpoint = cfg["asr"]["endpoint"].rstrip("/")
        # 复用 DASHSCOPE_API_KEY：优先用 asr.api_key，否则从 tts.api_key 取
        self.api_key = cfg["asr"]["api_key"] or cfg["tts"]["api_key"]
        self.model = cfg["asr"]["model"]
        self.timeout = cfg["asr"]["timeout"]
        self.max_audio_seconds = cfg["asr"]["max_audio_seconds"]
        self._client = httpx.AsyncClient(
            timeout=httpx.Timeout(float(self.timeout), connect=10.0)
        )

    def _headers(self) -> dict:
        return {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
        }

    async def transcribe(
        self,
        audio_base64: str,
        format: str = "webm",
        language: str = "zh",
    ) -> str:
        """
        将 base64 编码的音频转写为文本。

        Args:
            audio_base64: 浏览器 MediaRecorder 产出的音频（已 base64 编码）
            format: 音频格式，可选 webm / mp4 / wav / ogg
            language: 语种标识，默认 zh

        Returns:
            转写后的文本

        Raises:
            AsrError: API 调用失败 / 鉴权失败 / 超时
        """
        if not audio_base64:
            raise AsrError("音频数据为空")

        fmt = format.lower()
        if fmt not in SUPPORTED_FORMATS:
            raise AsrError(
                f"不支持的音频格式: {format}，仅支持 {list(SUPPORTED_FORMATS.keys())}"
            )

        if not self.api_key:
            raise AsrError("ASR API Key 未配置（DASHSCOPE_API_KEY）")

        url = f"{self.endpoint}/chat/completions"
        # OpenAI 兼容模式调用 qwen3-asr-flash
        # 注意 1：asr_options 需要平铺到请求 body 顶层（OpenAI SDK 的 extra_body
        #         只是个语法糖，传到底层 HTTP 请求时会合并到顶层）
        # 注意 2：input_audio.data 必须用 Data URL 格式
        #         data:<mediatype>;base64,<data>，不接受裸 base64 字符串
        audio_data_url = _to_data_url(audio_base64, SUPPORTED_FORMATS[fmt])
        payload = {
            "model": self.model,
            "messages": [
                {
                    "role": "user",
                    "content": [
                        {
                            "type": "input_audio",
                            "input_audio": {
                                "data": audio_data_url,
                                "format": fmt,
                            },
                        }
                    ],
                }
            ],
            "stream": False,
            "asr_options": {
                "language": language,
                "enable_itn": False,
            },
        }

        # 估算音频大小（base64 长度 → 字节数），粗略上限校验
        approx_bytes = len(audio_base64) * 3 // 4
        approx_seconds = approx_bytes / 16000  # 16kbps 估算
        if approx_seconds > self.max_audio_seconds * 2:
            logger.warning(
                f"音频估算时长 {approx_seconds:.1f}s 超过 {self.max_audio_seconds}s 上限"
            )

        last_error: Optional[AsrError] = None

        # 重试 1 次（总共 2 次尝试）
        for attempt in range(2):
            try:
                response = await self._client.post(
                    url, json=payload, headers=self._headers()
                )

                if response.status_code == 200:
                    data = response.json()
                    choices = data.get("choices", [])
                    if choices:
                        content = (
                            choices[0].get("message", {}).get("content", "") or ""
                        )
                        text = content.strip()
                        logger.info(
                            f"ASR 转写成功: model={self.model}, format={fmt}, "
                            f"text_len={len(text)}, bytes~{approx_bytes}"
                        )
                        return text
                    return ""

                # 错误状态码处理
                error_msg = self._parse_error(response)
                if response.status_code in (401, 403):
                    raise AsrError(f"ASR API Key 无效: {error_msg}", response.status_code)
                elif response.status_code == 429:
                    if attempt == 0:
                        await asyncio.sleep(2)
                        continue
                    raise AsrError(f"请求过于频繁: {error_msg}", response.status_code)
                elif response.status_code >= 500:
                    if attempt == 0:
                        await asyncio.sleep(1)
                        continue
                    raise AsrError(f"服务端错误: {error_msg}", response.status_code)
                else:
                    raise AsrError(
                        f"ASR 调用失败 ({response.status_code}): {error_msg}",
                        response.status_code,
                    )

            except httpx.TimeoutException:
                last_error = AsrError(f"ASR 调用超时（{self.timeout}s）")
                if attempt == 1:
                    raise last_error
                await asyncio.sleep(1)
            except httpx.ConnectError:
                last_error = AsrError("无法连接到 ASR 服务")
                if attempt == 1:
                    raise last_error
                await asyncio.sleep(1)
            except AsrError:
                raise
            except Exception as e:
                last_error = AsrError(f"ASR 调用异常: {str(e)}")
                if attempt == 1:
                    raise last_error
                await asyncio.sleep(1)

        raise last_error or AsrError("ASR 未知错误")

    async def close(self):
        """关闭底层 httpx 客户端"""
        if self._client:
            await self._client.aclose()
            self._client = None

    def _parse_error(self, response: httpx.Response) -> str:
        """从响应中提取错误消息"""
        try:
            data = response.json()
            if "error" in data:
                err = data["error"]
                if isinstance(err, dict):
                    return err.get("message", str(err))
                return str(err)
            return response.text[:300]
        except Exception:
            return response.text[:300]