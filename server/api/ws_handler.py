"""
WebSocket 处理模块
"""
import asyncio
import json
import logging
from typing import Dict, Optional

from fastapi import WebSocket, WebSocketDisconnect

from server.config import get_config
from server.models.session import SessionContext, SessionState
from server.agent.agent_engine import AgentEngine
from server.agent.conversation_manager import ConversationManager
from server.rag import build_rag_context


async def safe_send_json(ws: WebSocket, payload: dict) -> bool:
    """
    V67: 安全发送 WebSocket 消息, 捕获连接已关闭的 RuntimeError.

    背景: 长回答过程中, 客户端可能关闭页面/网络断开, 此时 WS 协程还在线程池里跑
    pipeline 回调, 会调 send_json. websockets 库在关闭后 send 会抛:
      RuntimeError: Cannot call "send" once a close message has been sent.
    之前这个异常会冒到 asyncio.Task 包装, 在生产日志刷一堆 traceback, 但客户端
    已经断开, 重连后会话可能丢状态. 现在静默丢弃, 但记录一次 WARN 方便追踪.

    Returns: True=成功发送, False=连接已关闭 (调用方无需重试).
    """
    try:
        await ws.send_json(payload)
        return True
    except RuntimeError as e:
        # 连接已关闭: websockets 库明确说 "Cannot call send once a close message has been sent"
        if "close" in str(e).lower() or "Cannot call" in str(e):
            logger.debug(f"safe_send_json: 连接已关闭, 丢弃事件 type={payload.get('type', '?')}")
            return False
        # 其他 RuntimeError 还是抛出去
        raise
    except Exception as e:
        # 其他异常 (网络断开, 协议错误) 也不应让 pipeline 崩
        # 但要看一下具体是什么, 短暂 WARN 后丢弃
        err_name = type(e).__name__
        if err_name in ('ConnectionClosed', 'ConnectionClosedError', 'ConnectionClosedOK'):
            logger.debug(f"safe_send_json: 连接已关闭 ({err_name}), 丢弃事件 type={payload.get('type', '?')}")
            return False
        logger.warning(f"safe_send_json: 发送失败 {err_name}: {e}, 丢弃事件 type={payload.get('type', '?')}")
        return False

from server.rag.collections_resolver import resolve_search_collections
from server.services.llm_client import LlmClient, LlmClientError
from server.services.redis_client import RedisClient
from server.services.minio_client import MinioClient
from server.services.qdrant_client import QdrantClient
from server.services.embedding_client import EmbeddingClient
from server.pipeline.streaming_pipeline import StreamingPipeline
from server.pipeline.segment_splitter import SegmentSplitter
from server.pipeline.segment_generator import SegmentGenerator
from server.services.tts_engine import TtsEngine
from server.services.semantic_analyzer import SemanticAnalyzer
from server.services.video_concat import VideoConcat

logger = logging.getLogger(__name__)


class WsHandler:
    """WebSocket 连接处理器"""

    def __init__(
        self,
        sessions: Dict[str, SessionContext],
        agent: AgentEngine,
        redis: RedisClient,
        minio: MinioClient,
        llm: LlmClient,
    ):
        self.sessions = sessions
        self.agent = agent
        self.redis = redis
        self.minio = minio
        self.llm = llm
        self.cfg = get_config()

    async def handle(self, ws: WebSocket, token: str):
        """
        处理 WebSocket 连接生命周期。

        Args:
            ws: WebSocket 连接
            token: 会话 token
        """
        # 1. Token 校验
        session_ctx = self.sessions.get(token)
        is_new = session_ctx is None

        if is_new:
            # 检查 Redis 中是否有历史（重连场景）
            exists_in_redis = False
            try:
                exists_in_redis = await self.redis.session_exists(token)
            except Exception:
                pass

            if not exists_in_redis:
                # 完全新会话：验证 token 是否是服务端生成的
                # 简单处理：接受任何 UUID 格式的 token
                await ws.close(code=4001, reason="会话不存在，请先调用 POST /api/session/create")
                return

            # 从 Redis 恢复会话上下文
            session_ctx = SessionContext(token=token)
            conversation = ConversationManager(
                session_token=token,
                system_prompt=self.cfg["system_prompt"],
            )
            await conversation.load_from_redis(self.redis)
            session_ctx.conversation = conversation
            self.sessions[token] = session_ctx
            logger.info(f"会话已恢复: {token}")

        # 2. 更新 WebSocket 引用
        session_ctx.ws = ws

        # 3. 发送 connected 事件
        await safe_send_json(ws, {
            "type": "connected",
            "session_token": token,
            "state": session_ctx.state.value,
        })

        # 4. 消息循环
        try:
            while True:
                raw = await ws.receive_text()

                try:
                    message = json.loads(raw)
                except json.JSONDecodeError:
                    await safe_send_json(ws, {
                        "type": "error",
                        "message": "消息格式错误，需要 JSON",
                    })
                    continue

                msg_type = message.get("type", "")

                if msg_type == "user_message":
                    await self._handle_user_message(session_ctx, message, ws)
                elif msg_type == "ack_played":
                    await self._handle_ack(session_ctx, message)
                elif msg_type == "cancel":
                    await self._handle_cancel(session_ctx, ws)
                else:
                    logger.warning(f"未知消息类型: {msg_type}")

        except WebSocketDisconnect:
            logger.info(f"WebSocket 断开: {token}")
        except Exception as e:
            logger.error(f"WebSocket 异常: {e}")
        finally:
            # 清理
            session_ctx.ws = None
            # 不立即删除 session，保留在内存中供重连使用

    async def _handle_user_message(
        self, session_ctx: SessionContext, message: dict, ws: WebSocket
    ):
        """处理用户消息（流式 LLM → 边生成边 TTS）"""
        text = message.get("text", "").strip()
        if not text:
            await safe_send_json(ws, {
                "type": "error",
                "message": "消息不能为空",
            })
            return

        # 如果已有活跃 Pipeline，先取消
        if session_ctx.pipeline:
            session_ctx.pipeline.cancel()
            session_ctx.pipeline = None

        # V17: 自增 msg_seq（唯一标识当前 user_message），并先推送一个 session_reset
        # 事件携带新 seq。客户端按 msg_seq 过滤旧会话的残留事件（避免取消后还未
        # 发送出的 R1 segment_ready 被误认为 R2 的段）。
        session_ctx.msg_seq += 1
        await safe_send_json(ws, {
            "type": "session_reset",
            "msg_seq": session_ctx.msg_seq,
        })

        # 更新状态
        session_ctx.state = SessionState.THINKING
        await self.redis.set_session_state(session_ctx.token, "thinking")

        # 立即通知前端进入思考状态（在 LLM 调用前推送）
        await safe_send_json(ws, {
            "type": "play_analysis",
            "loop": True,
        })
        await safe_send_json(ws, {
            "type": "state_change",
            "state": "thinking",
        })

        # 确保 conversation 存在
        if not session_ctx.conversation:
            session_ctx.conversation = ConversationManager(
                session_token=session_ctx.token,
                system_prompt=self.cfg["system_prompt"],
            )

        # 创建 generator（复用）
        tts = TtsEngine()
        semantic = SemanticAnalyzer(self.llm)
        concat = VideoConcat()
        generator = SegmentGenerator(tts, semantic, concat, self.minio)

        # 创建 pipeline（用于 ack 管理和推送），传入当前 msg_seq
        splitter = SegmentSplitter()
        pipeline = StreamingPipeline(
            session_id=session_ctx.token,
            ws=ws,
            generator=generator,
            splitter=splitter,
            msg_seq=session_ctx.msg_seq,
        )
        session_ctx.pipeline = pipeline

        # 在后台启动流式处理
        asyncio.create_task(self._run_streaming_flow(
            session_ctx, text, ws, pipeline, generator
        ))

    async def _run_streaming_flow(
        self,
        session_ctx: SessionContext,
        user_text: str,
        ws: WebSocket,
        pipeline: StreamingPipeline,
        generator: SegmentGenerator,
    ):
        """
        流式处理流程：LLM 边生成 → 边识别段落 → 立即启动 TTS+拼接。
        完成后通过 pipeline 的 ack 机制逐段推送。
        """
        try:
            # Step 1: 保存用户消息
            await session_ctx.conversation.add_message("user", user_text, self.redis)

            # Step 2: 检查 token 溢出
            await session_ctx.conversation.summarize_if_needed(self.llm)

            # Step 3: 获取 messages（含 RAG 检索）
            rag_context = await self._retrieve_rag_context(user_text)
            messages = session_ctx.conversation.get_messages_for_llm(rag_context=rag_context)

            logger.info(f"发送 LLM 流式请求: {len(messages)} 条消息")

            # Step 4: 流式 LLM，边接收边创建段生成任务
            buffer = ""
            segment_index = 0
            pending_tasks: list[tuple[int, asyncio.Task]] = []
            full_reply = ""

            async for token in self.llm.chat_stream(messages):
                buffer += token
                full_reply += token

                if pipeline._cancel.is_set():
                    break

                # 检测句子边界，满 25 字立即启动一段
                # 同时防止 buffer 过大（>200 字无标点则强制按逗号/换行分割）
                while True:
                    # 找到第一个满足长度要求的句子分隔符
                    boundary = -1
                    for sep in "。！？；":
                        pos = buffer.find(sep)
                        if pos != -1 and pos + 1 >= 25:
                            if boundary == -1 or pos < boundary:
                                boundary = pos

                    # buffer 过大则强制按逗号/换行分割
                    if boundary == -1 and len(buffer) > 200:
                        for sep in "，,\n、":
                            pos = buffer.find(sep)
                            if pos != -1 and pos + 1 >= 25:
                                if boundary == -1 or pos < boundary:
                                    boundary = pos

                    if boundary == -1:
                        break  # 没有满足长度要求的句子

                    sentence = buffer[:boundary + 1]
                    buffer = buffer[boundary + 1:]

                    logger.info(f"流式识别段 {segment_index}: {sentence[:30]}...")
                    # V53: 诊断—输出完整句子文本以便检测重复
                    logger.info(f"[V53-stream-seg] idx={segment_index} text={sentence!r}")

                    # 立即启动段生成（TTS + 语义分析 + 拼接 + MinIO）
                    task = asyncio.ensure_future(
                        generator.generate(
                            sentence, segment_index, session_ctx.token,
                            skip_llm_semantic=True,
                        )
                    )
                    pending_tasks.append((segment_index, task))
                    segment_index += 1

            # 处理剩余 buffer
            if buffer.strip() and not pipeline._cancel.is_set():
                logger.info(f"流式识别末段 {segment_index}: {buffer[:30]}...")
                task = asyncio.ensure_future(
                    generator.generate(
                        buffer.strip(), segment_index, session_ctx.token,
                        skip_llm_semantic=True,
                    )
                )
                pending_tasks.append((segment_index, task))

            # 保存助手回复到对话历史
            await session_ctx.conversation.add_message("assistant", full_reply, self.redis)
            logger.info(f"LLM 流式回复完成: {len(full_reply)} 字, {len(pending_tasks)} 段")

            if pipeline._cancel.is_set():
                for _, task in pending_tasks:
                    task.cancel()
                return

            if not pending_tasks:
                await safe_send_json(ws, {"type": "state_change", "state": "idle"})
                return

            # Step 5: 等待首段 → 立即推送
            first_idx, first_task = pending_tasks[0]
            first_result = await first_task

            if pipeline._cancel.is_set():
                for _, task in pending_tasks:
                    task.cancel()
                return

            if isinstance(first_result, Exception) or first_result.error:
                err_msg = str(first_result) if isinstance(first_result, Exception) else first_result.error
                await self._send_error(ws, err_msg, pipeline)
                return

            await pipeline._push_segment(first_idx, first_result)
            await safe_send_json(ws, {"type": "state_change", "state": "speaking"})

            # Step 6: 后续段直接推送（不等 ack）。与 streaming_pipeline.run() V4 优化一致：
            # 段生成完毕后立即推送，客户端自行管理视频播放列表，消除 ack 串行等待延迟。
            for i in range(1, len(pending_tasks)):
                if pipeline._cancel.is_set():
                    break

                idx, task = pending_tasks[i]
                result = await task

                if pipeline._cancel.is_set():
                    break

                if isinstance(result, Exception):
                    await self._send_error(ws, str(result), pipeline)
                    break
                if result.error:
                    await self._send_error(ws, result.error, pipeline)
                    break

                await pipeline._push_segment(idx, result)

            # Step 7: 全部完成
            if not pipeline._cancel.is_set():
                await safe_send_json(ws, {"type": "response_complete", "total_segments": len(pending_tasks)})
                await safe_send_json(ws, {"type": "all_completed"})
                await safe_send_json(ws, {"type": "return_to_idle"})
                await safe_send_json(ws, {"type": "state_change", "state": "idle"})

        except LlmClientError as e:
            logger.error(f"LLM 流式调用失败: {e}")
            await self._reset_and_error(ws, session_ctx, f"抱歉，出了点问题，请稍后重试。({e})")
        except Exception as e:
            logger.error(f"流式处理异常: {e}")
            await self._reset_and_error(ws, session_ctx, "抱歉，出了点问题，请稍后重试")

    async def _retrieve_rag_context(self, query: str) -> Optional[str]:
        """
        从 Qdrant 检索与查询相关的知识，构建 RAG 上下文。
        """
        import json as _json

        # 检查 RAG 客户端是否可用
        has_qdrant = hasattr(self.agent, 'qdrant') and self.agent.qdrant is not None
        has_embedding = hasattr(self.agent, 'embedding') and self.agent.embedding is not None
        if not has_qdrant or not has_embedding:
            logger.warning(
                f"RAG 跳过: qdrant={has_qdrant}, embedding={has_embedding}, "
                f"agent_attrs={[a for a in dir(self.agent) if not a.startswith('_')]}"
            )
            return None

        try:
            role_collections_raw = self.cfg["rag"]["role_collections"]
            if isinstance(role_collections_raw, str):
                role_collections = _json.loads(role_collections_raw)
            else:
                role_collections = role_collections_raw

            role_cols = role_collections.get("普兰", "*")
            logger.info(f"RAG: role_cols={role_cols}, raw={role_collections_raw}")

            # 统一解析：支持 "*"、"pulan_*"、标量、列表四种语义
            collections = await resolve_search_collections(self.agent.qdrant, role_cols)
            logger.info(f"RAG: 解析得到 {len(collections)} 个集合: {collections}")
            if not collections:
                logger.warning("RAG 跳过: 无可用集合")
                return None

            embeddings = await self.agent.embedding.embed([query])
            query_vector = embeddings[0]
            logger.info(f"RAG: 查询嵌入完成, 向量维度={len(query_vector)}")

            top_k = self.cfg["rag"]["top_k"]
            results = await self.agent.qdrant.search_multi(collections, query_vector, limit=top_k)
            logger.info(f"RAG: 检索返回 {len(results)} 条结果")

            if not results:
                logger.warning("RAG 跳过: 检索无结果")
                return None

            rag_context = build_rag_context(results)
            logger.info(
                f"RAG 检索完成: {len(collections)} 个集合, {len(results)} 条结果, "
                f"top score={results[0]['score']:.3f}"
            )
            return rag_context if rag_context else None

        except Exception as e:
            logger.warning(f"RAG 检索失败，降级为纯 LLM 回复: {e}", exc_info=True)
            return None

    async def _send_error(self, ws: WebSocket, message: str, pipeline: StreamingPipeline):
        """推送错误并清理 pipeline"""
        await safe_send_json(ws, {"type": "error", "message": message})
        await safe_send_json(ws, {"type": "state_change", "state": "idle"})
        pipeline._cancel.set()

    async def _reset_and_error(self, ws: WebSocket, session_ctx: SessionContext, message: str):
        """重置状态并推送错误"""
        session_ctx.state = SessionState.IDLE
        await self.redis.set_session_state(session_ctx.token, "idle")
        await safe_send_json(ws, {"type": "error", "message": message})
        await safe_send_json(ws, {"type": "state_change", "state": "idle"})

    async def _handle_ack(self, session_ctx: SessionContext, message: dict):
        """处理前端播放确认"""
        segment_index = message.get("segment_index", -1)

        if session_ctx.pipeline:
            session_ctx.pipeline.handle_ack(segment_index)

        # 更新状态
        if session_ctx.state == SessionState.SPEAKING:
            session_ctx.state = SessionState.SPEAKING  # 保持 speaking，等下一段

    async def _handle_cancel(self, session_ctx: SessionContext, ws: WebSocket):
        """处理用户中断"""
        logger.info(f"用户中断: {session_ctx.token}")

        # 取消 Pipeline
        if session_ctx.pipeline:
            session_ctx.pipeline.cancel()
            session_ctx.pipeline = None

        # 更新状态
        session_ctx.state = SessionState.IDLE
        await self.redis.set_session_state(session_ctx.token, "idle")

        # 推送状态变更
        await safe_send_json(ws, {
            "type": "state_change",
            "state": "idle",
        })
