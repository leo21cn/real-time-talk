"""
流式分段引擎：接收完整回复文本，异步完成分段生成并通过 WebSocket 推送
"""
import asyncio
import logging
from typing import Optional

from fastapi import WebSocket

from server.pipeline.segment_splitter import SegmentSplitter, Segment
from server.pipeline.segment_generator import SegmentGenerator, SegmentResult

logger = logging.getLogger(__name__)


class StreamingPipeline:
    """
    流式分段生成与推送引擎。

    工作流程:
    1. 接收完整回复文本 → 分句切段
    2. asyncio.gather 并行生成所有段
    3. 首段就绪 → 立即推送 segment_ready
    4. 逐段确认式推送后续（等待 ack_played）
    5. 段未就绪 → 推送 play_analysis 衔接
    6. 全部完成 → 推送 all_completed + return_to_idle
    """

    def __init__(
        self,
        session_id: str,
        ws: WebSocket,
        generator: SegmentGenerator,
        splitter: SegmentSplitter,
        msg_seq: int = 0,
    ):
        self.session_id = session_id
        self.ws = ws
        self.generator = generator
        self.splitter = splitter
        self._cancel = asyncio.Event()
        self._ack_queue: asyncio.Queue = asyncio.Queue()
        self._current_segment_index = 0
        # V17: 记录当前消息序号，在所有推送事件中携带。客户端据此丢弃旧会话的残留事件。
        self.msg_seq = msg_seq

    async def run(self, full_reply_text: str) -> None:
        """
        执行完整的流式分段生成与推送流程。

        关键优化：首段（index=0）完成后立即推送，不等后续段。
        首段跳过 LLM 语义分析（关键词回退），节省 2-6 秒。

        Args:
            full_reply_text: LLM 生成的完整回复文本
        """
        try:
            # Step 1: 分句切段
            segments = self.splitter.split(full_reply_text)
            logger.info(f"Pipeline [{self.session_id}]: {len(segments)} 段待生成")

            if self._cancel.is_set():
                return

            if not segments:
                await self._push_event({"type": "state_change", "state": "idle"})
                return

            # Step 2: 创建所有段的生成任务（并行启动，首段 skip_llm）
            # 所有段统一使用关键字回退语义分析，跳过 LLM 调用（省 14s/段）
            tasks = []
            for seg in segments:
                task = asyncio.ensure_future(
                    self.generator.generate(
                        seg.text, seg.index, self.session_id,
                        skip_llm_semantic=True,
                    )
                )
                tasks.append(task)

            # V46: segment_pending 推送 mp4 URL（PC 浏览器优先 H.264 硬解）。
            # 若 mp4 文件不存在（生成失败），客户端会 404 回退 — 但 webm 永远存在。
            for seg in segments:
                pending_url = f"/api/media/{self.session_id}/segment_{seg.index}.mp4?seq={self.msg_seq}"
                await self._push_event({
                    "type": "segment_pending",
                    "index": seg.index,
                    "video_url": pending_url,
                })

            # Step 3: 等待首段完成 → 立即推送（后续段继续并行生成）
            first_result = await tasks[0]

            if self._cancel.is_set():
                for t in tasks:
                    t.cancel()
                return

            if isinstance(first_result, Exception) or first_result.error:
                err_msg = str(first_result) if isinstance(first_result, Exception) else first_result.error
                await self._push_error(err_msg)
                await self._push_event({"type": "state_change", "state": "idle"})
                return

            # 首段就绪！立即推送
            await self._push_segment(0, first_result)
            await self._push_event({"type": "state_change", "state": "speaking"})

            # Step 4: 按 index 顺序推送后续段（不等 ack，段 ready 后立即 push）
            # V4 优化：不等客户端 ack，消除“ack 到达后等段生成”的间隔。
            # 客户端会在收到 segment_ready 后预下载下一段视频（blob），
            # 段 i 视频 ended 后从预加载缓存切换，无停顿。
            for i in range(1, len(tasks)):
                if self._cancel.is_set():
                    break

                # 直接等段 i 生成（不等 ack）
                # 如果 tasks[i] 已在 Step 2 启动，这里可能已 ready，
                # await 会立即返回，push 动作只在 ack 后。
                result = await tasks[i]

                if self._cancel.is_set():
                    break

                if isinstance(result, Exception):
                    await self._push_error(str(result))
                    break

                if result.error:
                    await self._push_error(result.error)
                    break

                # 立即 push（不等 ack）— 客户端会预加载下一段
                await self._push_segment(i, result)

            # Step 5: 全部完成 → 回到待机
            if not self._cancel.is_set():
                await self._push_event({"type": "all_completed"})
                await self._push_event({"type": "return_to_idle"})
                await self._push_event({"type": "state_change", "state": "idle"})

        except Exception as e:
            logger.error(f"Pipeline [{self.session_id}] 异常: {e}")
            await self._push_error(f"系统异常: {e}")
            await self._push_event({"type": "state_change", "state": "idle"})

    async def _push_segment(self, index: int, result: SegmentResult) -> None:
        """
        推送段落就绪事件。

        V8: 不再逐字推送 bubble_char。打字机效果由客户端本地动画实现
        （useTypingAnimation 按 duration_ms * 60% 推进 displayedLen），
        消除 WebSocket 串行推送造成的卡通形象与文字不同步。

        V46: 同时推送 webm 和 mp4 两个 URL，客户端按 prefersMp4() 选优。
        - video_url: 首选（mp4 优先，没有则 webm）
        - video_url_webm / video_url_mp4: 显式供客户端 fallback
        """
        try:
            # 使用 API 代理路径（避免 MinIO presigned URL 在浏览器不可达）
            # V18: 添加 seq 参数区分不同轮对话，避免浏览器/IndexedDB 缓存碰撞
            video_url_webm = f"/api/media/{self.session_id}/segment_{index}.webm?seq={self.msg_seq}"
            video_url_mp4 = f"/api/media/{self.session_id}/segment_{index}.mp4?seq={self.msg_seq}"
            # 优先 mp4（PC 浏览器 H.264 硬解，避免 VP9 软解卡顿）
            video_url = video_url_mp4 if result.video_path_mp4 else video_url_webm

            # 一次性推送 segment_ready（含完整 text + duration_ms）
            await self._push_event({
                "type": "segment_ready",
                "index": index,
                "video_url": video_url,
                "video_url_webm": video_url_webm,
                "video_url_mp4": video_url_mp4,
                "duration_ms": result.duration_ms,
                "text": result.text,
            })

            # V8 移除：bubble_char / bubble_dismiss 串行推送循环
            # 客户端 useTypingAnimation 会根据 duration_ms 自动推进 displayedLen

        except Exception as e:
            logger.error(f"推送段落 {index} 失败: {e}")

    async def _wait_for_ack(self) -> str:
        """
        等待前端 ack_played 确认。
        段间静默等待，不推送额外动画（避免切换为思考手势打断说话形象）。
        """
        try:
            # 先等待一小段时间，如果队列中有 ack 则直接返回
            ack = await asyncio.wait_for(self._ack_queue.get(), timeout=0.5)
            return ack
        except asyncio.TimeoutError:
            # 超时则继续等待 ack，不再推送 play_analysis
            return await self._ack_queue.get()

    async def _push_event(self, event: dict) -> None:
        """推送事件到 WebSocket"""
        # V17: 所有推送事件携带 msg_seq，客户端据此过滤旧会话的残留事件。
        event["msg_seq"] = self.msg_seq
        try:
            await self.ws.send_json(event)
        except Exception:
            logger.warning(f"WebSocket 推送失败，可能已断开: {event.get('type')}")

    async def _push_error(self, message: str) -> None:
        """推送错误事件"""
        await self._push_event({
            "type": "error",
            "message": message,
        })

    def handle_ack(self, segment_index: int):
        """接收前端的播放确认"""
        try:
            self._ack_queue.put_nowait("ack")
        except asyncio.QueueFull:
            pass

    def cancel(self):
        """取消当前 Pipeline"""
        self._cancel.set()
        try:
            self._ack_queue.put_nowait("cancel")
        except asyncio.QueueFull:
            pass
        logger.info(f"Pipeline [{self.session_id}] 已取消")
