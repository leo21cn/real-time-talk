"""
MinIO 操作封装
"""
import logging
from datetime import timedelta
from typing import Optional

from minio import Minio
from minio.error import S3Error

from server.config import get_config

logger = logging.getLogger(__name__)


class MinioClientError(Exception):
    """MinIO 操作错误"""
    pass


class MinioClient:
    """MinIO 客户端封装"""

    def __init__(self):
        cfg = get_config()
        self.endpoint = cfg["minio"]["endpoint"]
        self.access_key = cfg["minio"]["access_key"]
        self.secret_key = cfg["minio"]["secret_key"]
        self.bucket_name = cfg["minio"]["bucket"]
        self.presigned_ttl = cfg["minio"]["presigned_url_ttl_seconds"]
        self._client: Optional[Minio] = None
        self._available: bool = True

    def connect(self):
        """创建 MinIO 客户端连接"""
        try:
            self._client = Minio(
                self.endpoint,
                access_key=self.access_key,
                secret_key=self.secret_key,
                secure=False,  # 内网部署，不使用 TLS
            )
            logger.info(f"MinIO 客户端已创建: {self.endpoint}")
        except Exception as e:
            logger.error(f"MinIO 客户端创建失败: {e}")
            self._available = False

    async def ensure_bucket(self) -> bool:
        """确保 bucket 存在，不存在则创建"""
        if not self._client:
            return False
        try:
            found = self._client.bucket_exists(self.bucket_name)
            if not found:
                self._client.make_bucket(self.bucket_name)
                logger.info(f"MinIO Bucket 已创建: {self.bucket_name}")
            else:
                logger.info(f"MinIO Bucket 已存在: {self.bucket_name}")
            return True
        except S3Error as e:
            logger.error(f"MinIO Bucket 操作失败: {e}")
            self._available = False
            return False

    @property
    def available(self) -> bool:
        return self._available and self._client is not None

    async def upload(self, file_path: str, object_name: str) -> str:
        """
        上传文件到 MinIO。

        Returns:
            MinIO object name
        """
        if not self.available:
            logger.warning(f"MinIO 不可用，跳过上传: {file_path}")
            return object_name

        try:
            self._client.fput_object(
                self.bucket_name,
                object_name,
                file_path,
            )
            logger.info(f"MinIO 上传成功: {object_name}")
            return object_name
        except S3Error as e:
            logger.error(f"MinIO 上传失败: {e}")
            raise MinioClientError(f"MinIO 上传失败: {e}")

    async def object_exists(self, object_name: str) -> bool:
        """检查对象是否存在"""
        if not self.available:
            return False
        try:
            self._client.stat_object(self.bucket_name, object_name)
            return True
        except S3Error:
            return False

    async def get_presigned_url(self, object_name: str) -> Optional[str]:
        """
        获取文件的 Presigned URL（GET 访问）。
        先检查对象是否存在，不存在则返回 None。
        """
        if not self.available:
            return None

        # 检查对象是否存在
        if not await self.object_exists(object_name):
            logger.warning(f"MinIO 对象不存在: {object_name}")
            return None

        try:
            url = self._client.presigned_get_object(
                self.bucket_name,
                object_name,
                expires=timedelta(seconds=self.presigned_ttl),
            )
            return url
        except S3Error as e:
            logger.error(f"MinIO Presigned URL 生成失败: {e}")
            return None

    async def delete_prefix(self, prefix: str) -> None:
        """删除指定前缀下的所有对象"""
        if not self.available:
            return

        try:
            objects = self._client.list_objects(self.bucket_name, prefix=prefix, recursive=True)
            for obj in objects:
                self._client.remove_object(self.bucket_name, obj.object_name)
                logger.debug(f"MinIO 已删除: {obj.object_name}")
        except S3Error as e:
            logger.warning(f"MinIO 删除前缀失败 (prefix={prefix}): {e}")

