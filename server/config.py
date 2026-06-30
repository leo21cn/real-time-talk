"""
配置加载模块

优先级: 环境变量 > config.json
"""
import json
import os
from pathlib import Path
from typing import Optional

from pydantic import BaseModel, Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class LlmConfig(BaseModel):
    endpoint: str = "https://api.openai.com/v1"
    api_key: str = ""
    model: str = "gpt-4o"
    max_tokens: int = 2048


class TtsConfig(BaseModel):
    api_key: str = ""
    voice: str = "Cherry"
    speed: float = 1.0


class AvatarConfig(BaseModel):
    speaker: str = "short-hair-teacher-girl"
    clips_dir: str = "clips/short-hair-teacher-girl"
    idle_animation: str = "clips/short-hair-teacher-girl/idle/idle_breathing.webm"


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
    llm_max_tokens: int = Field(default=2048, alias="LLM_MAX_TOKENS")

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
            "max_tokens": _get(["llm", "max_tokens"], json_cfg, env_settings.llm_max_tokens, 2048),
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
