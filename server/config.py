"""
配置加载模块

优先级: 环境变量 > config.json
"""
import json
import os
from pathlib import Path
from typing import Optional

import json as _json
from pydantic import BaseModel, Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class LlmConfig(BaseModel):
    endpoint: str = "https://api.openai.com/v1"
    api_key: str = ""
    model: str = "gpt-4o"
    max_tokens: int = 1200


class TtsConfig(BaseModel):
    api_key: str = ""
    voice: str = "Cherry"
    speed: float = 1.0


class AvatarConfig(BaseModel):
    speaker: str = "short-hair-teacher-girl"
    clips_dir: str = "clips/short-hair-teacher-girl"
    idle_animation: str = "clips/short-hair-teacher-girl/idle/idle_breathing.webm"
    # 切片资源版本号：客户端预缓存按此版本号生成 URL ?v=N
    # 发布新切片时 bump 此字段（同步 config.json 与服务端环境变量 AVATAR_CLIP_VERSION）
    clip_version: int = 10


class RedisConfig(BaseModel):
    url: str = "redis://localhost:6379/0"
    session_ttl_hours: int = 24


class MinioConfig(BaseModel):
    endpoint: str = "localhost:9000"
    access_key: str = "minioadmin"
    secret_key: str = "minioadmin"
    bucket: str = "realtimetalk"
    presigned_url_ttl_seconds: int = 600


class ServerConfig(BaseModel):
    host: str = "0.0.0.0"
    port: int = 8000


class FfmpegConfig(BaseModel):
    path: str = "ffmpeg"
    gpu_encoder: Optional[str] = "auto"


class QdrantConfig(BaseModel):
    url: str = "http://localhost:6333"


class EmbeddingConfig(BaseModel):
    endpoint: str = "https://api.openai.com/v1"
    api_key: str = ""
    model: str = "text-embedding-v3"


class RagConfig(BaseModel):
    top_k: int = 5
    role_collections: str = '{"普兰": "pulan_*"}'


class AsrConfig(BaseModel):
    """语音识别（ASR）配置，复用 DASHSCOPE_API_KEY"""
    endpoint: str = "https://dashscope.aliyuncs.com/compatible-mode/v1"
    api_key: str = ""
    model: str = "qwen3-asr-flash"
    timeout: int = 30
    max_audio_seconds: int = 60


class AppConfig(BaseSettings):
    """应用配置（支持环境变量覆盖）"""
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    # LLM 配置
    llm_endpoint: str = Field(default="https://api.openai.com/v1", alias="LLM_ENDPOINT")
    llm_api_key: str = Field(default="", alias="LLM_API_KEY")
    llm_model: str = Field(default="gpt-4o", alias="LLM_MODEL")
    llm_max_tokens: int = Field(default=1200, alias="LLM_MAX_TOKENS")

    # TTS 配置
    tts_api_key: str = Field(default="", alias="DASHSCOPE_API_KEY")
    tts_voice: str = Field(default="Cherry", alias="TTS_VOICE")
    tts_speed: float = Field(default=1.0, alias="TTS_SPEED")

    # Redis 配置
    redis_url: str = Field(default="redis://localhost:6379/0", alias="REDIS_URL")
    redis_session_ttl_hours: int = Field(default=24, alias="REDIS_SESSION_TTL_HOURS")

    # MinIO 配置
    minio_access_key: str = Field(default="minioadmin", alias="MINIO_ACCESS_KEY")
    minio_secret_key: str = Field(default="minioadmin", alias="MINIO_SECRET_KEY")
    minio_endpoint: str = Field(default="minio:9000", alias="MINIO_ENDPOINT")
    minio_bucket: str = Field(default="realtimetalk", alias="MINIO_BUCKET")
    minio_presigned_url_ttl_seconds: int = Field(default=600, alias="MINIO_PRESIGNED_URL_TTL_SECONDS")

    # 服务配置
    server_host: str = Field(default="0.0.0.0", alias="SERVER_HOST")
    server_port: int = Field(default=8000, alias="SERVER_PORT")

    # FFmpeg 配置
    ffmpeg_path: str = Field(default="ffmpeg", alias="FFMPEG_PATH")
    ffmpeg_gpu_encoder: Optional[str] = Field(default="auto", alias="FFMPEG_GPU_ENCODER")

    # Qdrant 配置
    qdrant_url: str = Field(default="http://localhost:6333", alias="QDRANT_URL")
    qdrant_api_key: str = Field(default="", alias="QDRANT_API_KEY")

    # Embedding 配置
    embedding_endpoint: str = Field(default="https://api.openai.com/v1", alias="EMBEDDING_ENDPOINT")
    embedding_api_key: str = Field(default="", alias="DASHSCOPE_API_KEY")
    embedding_model: str = Field(default="text-embedding-v3", alias="EMBEDDING_MODEL")

    # RAG 配置
    rag_top_k: int = Field(default=5, alias="RAG_TOP_K")
    rag_role_collections: str = Field(default='{"普兰": "pulan_*"}', alias="ROLE_COLLECTIONS")

    # ASR 配置（API Key 复用 DASHSCOPE_API_KEY）
    asr_endpoint: str = Field(default="https://dashscope.aliyuncs.com/compatible-mode/v1", alias="ASR_ENDPOINT")
    asr_api_key: str = Field(default="", alias="DASHSCOPE_API_KEY")
    asr_model: str = Field(default="qwen3-asr-flash", alias="ASR_MODEL")
    asr_timeout: int = Field(default=30, alias="ASR_TIMEOUT")
    asr_max_audio_seconds: int = Field(default=60, alias="ASR_MAX_AUDIO_SECONDS")

    # 知识管理 Admin Token（空则跳过鉴权）
    knowledge_admin_token: str = Field(default="", alias="KNOWLEDGE_ADMIN_TOKEN")


def _load_json_config() -> dict:
    """从 config.json 加载配置"""
    config_path = Path("config.json")
    if config_path.exists():
        with open(config_path, "r", encoding="utf-8") as f:
            return json.load(f)
    return {}


def _load_default_system_prompt() -> str:
    """加载出厂默认 system prompt（从文件）"""
    prompt_path = Path("server/resources/default_system_prompt.txt")
    # Docker 中路径可能是 /app/resources/default_system_prompt.txt
    if not prompt_path.exists():
        prompt_path = Path("resources/default_system_prompt.txt")
    if prompt_path.exists():
        return prompt_path.read_text(encoding="utf-8").strip()
    return ""


def load_config() -> dict:
    """
    加载完整配置（合并 config.json + 环境变量）。
    返回 flatten 后的配置字典，供各模块使用。
    """
    # 1. 加载 JSON 配置
    json_cfg = _load_json_config()

    # 2. 加载环境变量（pydantic-settings）
    env_settings = AppConfig()

    # 3. 合并：环境变量优先
    def _get(key_parts: list, json_data: dict, env_value, default):
        """从 JSON 中按路径取值，环境变量非空则覆盖"""
        val = default
        d = json_data
        for k in key_parts:
            if isinstance(d, dict) and k in d:
                d = d[k]
            else:
                d = default
                break
        if not isinstance(d, dict) or key_parts[-1] in str(type(d)):
            # 尝试取值
            try:
                tmp = json_data
                for k in key_parts:
                    tmp = tmp[k]
                val = tmp
            except (KeyError, TypeError):
                val = default
        else:
            val = default
        # 环境变量覆盖
        if env_value is not None and env_value != default and env_value != "":
            return env_value
        if val == default or val == "":
            return env_value if env_value else default
        return val

    config = {
        "llm": {
            "endpoint": _get(["llm", "endpoint"], json_cfg, env_settings.llm_endpoint, "https://api.openai.com/v1"),
            "api_key": _get(["llm", "api_key"], json_cfg, env_settings.llm_api_key, ""),
            "model": _get(["llm", "model"], json_cfg, env_settings.llm_model, "gpt-4o"),
            "max_tokens": _get(["llm", "max_tokens"], json_cfg, env_settings.llm_max_tokens, 1200),
        },
        "tts": {
            "api_key": _get(["tts", "api_key"], json_cfg, env_settings.tts_api_key, ""),
            "voice": _get(["tts", "voice"], json_cfg, env_settings.tts_voice, "Cherry"),
            "speed": _get(["tts", "speed"], json_cfg, env_settings.tts_speed, 1.0),
        },
        "avatar": {
            "speaker": json_cfg.get("avatar", {}).get("speaker", "short-hair-teacher-girl"),
            "clips_dir": json_cfg.get("avatar", {}).get("clips_dir", "clips/short-hair-teacher-girl"),
            "idle_animation": json_cfg.get("avatar", {}).get("idle_animation", "clips/short-hair-teacher-girl/idle/idle_breathing.webm"),
            "clip_version": int(json_cfg.get("avatar", {}).get("clip_version", 10)),
        },
        "system_prompt": json_cfg.get("system_prompt", "") or _load_default_system_prompt(),
        "redis": {
            "url": _get(["redis", "url"], json_cfg, env_settings.redis_url, "redis://localhost:6379/0"),
            "session_ttl_hours": _get(["redis", "session_ttl_hours"], json_cfg, env_settings.redis_session_ttl_hours, 24),
        },
        "minio": {
            "endpoint": _get(["minio", "endpoint"], json_cfg, env_settings.minio_endpoint, "minio:9000"),
            "access_key": _get(["minio", "access_key"], json_cfg, env_settings.minio_access_key, "minioadmin"),
            "secret_key": _get(["minio", "secret_key"], json_cfg, env_settings.minio_secret_key, "minioadmin"),
            "bucket": _get(["minio", "bucket"], json_cfg, env_settings.minio_bucket, "realtimetalk"),
            "presigned_url_ttl_seconds": _get(["minio", "presigned_url_ttl_seconds"], json_cfg, env_settings.minio_presigned_url_ttl_seconds, 600),
        },
        "server": {
            "host": _get(["server", "host"], json_cfg, env_settings.server_host, "0.0.0.0"),
            "port": _get(["server", "port"], json_cfg, env_settings.server_port, 8000),
        },
        "ffmpeg": {
            "path": _get(["ffmpeg", "path"], json_cfg, env_settings.ffmpeg_path, "ffmpeg"),
            "gpu_encoder": _get(["ffmpeg", "gpu_encoder"], json_cfg, env_settings.ffmpeg_gpu_encoder, "auto"),
        },
        "qdrant": {
            "url": _get(["qdrant", "url"], json_cfg, env_settings.qdrant_url, "http://localhost:6333"),
            "api_key": _get(["qdrant", "api_key"], json_cfg, env_settings.qdrant_api_key, ""),
        },
        "embedding": {
            "endpoint": _get(["embedding", "endpoint"], json_cfg, env_settings.embedding_endpoint, "https://api.openai.com/v1"),
            "api_key": _get(["embedding", "api_key"], json_cfg, env_settings.embedding_api_key, ""),
            "model": _get(["embedding", "model"], json_cfg, env_settings.embedding_model, "text-embedding-v3"),
        },
        "rag": {
            "top_k": int(_get(["rag", "top_k"], json_cfg, env_settings.rag_top_k, 5)),
            "role_collections": _get(["rag", "role_collections"], json_cfg, env_settings.rag_role_collections, '{"普兰": "pulan_*"}'),
        },
        "asr": {
            "endpoint": _get(["asr", "endpoint"], json_cfg, env_settings.asr_endpoint, "https://dashscope.aliyuncs.com/compatible-mode/v1"),
            "api_key": _get(["asr", "api_key"], json_cfg, env_settings.asr_api_key, ""),
            "model": _get(["asr", "model"], json_cfg, env_settings.asr_model, "qwen3-asr-flash"),
            "timeout": _get(["asr", "timeout"], json_cfg, env_settings.asr_timeout, 30),
            "max_audio_seconds": _get(["asr", "max_audio_seconds"], json_cfg, env_settings.asr_max_audio_seconds, 60),
        },
        "knowledge_admin_token": env_settings.knowledge_admin_token or "",
    }

    return config


# 全局配置实例（在 main.py 启动时初始化）
_config: Optional[dict] = None


def get_config() -> dict:
    """获取全局配置（懒加载）"""
    global _config
    if _config is None:
        _config = load_config()
    return _config


def reload_config():
    """重新加载配置"""
    global _config
    _config = load_config()
