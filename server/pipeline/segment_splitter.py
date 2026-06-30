"""
文本分段器：按中文标点将文本切分为段落
"""
import re
import logging
from dataclasses import dataclass
from typing import List

logger = logging.getLogger(__name__)

# 分段阈值：每段最少 50 字符
SEGMENT_THRESHOLD = 50

# 中文句子分隔符
SENTENCE_SEPARATORS = re.compile(r"[。！？；]")


@dataclass
class Segment:
    """文本段落"""
    index: int
    text: str


class SegmentSplitter:
    """文本分段器"""

    def __init__(self, threshold: int = SEGMENT_THRESHOLD):
        self.threshold = threshold

    def split(self, text: str) -> List[Segment]:
        """
        将文本按中文标点切分为多个段落。

        算法:
        1. 以 。！？； 拆分句子
        2. 累加至 ≥ threshold 字符形成一个段落
        3. 尾部不足 threshold 的单独成段
        4. 每段以完整句子结尾

        Args:
            text: 完整回复文本

        Returns:
            段落列表
        """
        if not text.strip():
            return [Segment(index=0, text="")]

        # Step 1: 按标点拆分为句子（保留标点）
        sentences = self._split_sentences(text)

        # Step 2: 累加句子形成段落
        segments: List[Segment] = []
        current_text = ""
        segment_idx = 0

        for sentence in sentences:
            if len(current_text) + len(sentence) >= self.threshold and current_text:
                # 当前积累已满足阈值，形成一个段落
                segments.append(Segment(index=segment_idx, text=current_text.strip()))
                segment_idx += 1
                current_text = sentence
            else:
                current_text += sentence

        # Step 3: 最后剩余的句子作为尾段
        if current_text.strip():
            segments.append(Segment(index=segment_idx, text=current_text.strip()))

        # 如果没有分出任何段（极端情况），整体作为一段
        if not segments:
            segments.append(Segment(index=0, text=text.strip()))

        logger.info(f"文本分段: {len(text)} 字 → {len(segments)} 段 (threshold={self.threshold})")
        return segments

    def _split_sentences(self, text: str) -> List[str]:
        """按中文标点拆分句子，保留标点在句子末尾"""
        sentences = []
        current = ""
        for char in text:
            current += char
            if char in "。！？；":
                sentences.append(current)
                current = ""
        if current:
            sentences.append(current)
        return sentences


def should_trigger_multisegment(text: str, threshold: int = SEGMENT_THRESHOLD) -> bool:
    """判断文本是否触发多段生成（> 50 字）"""
    return len(text) > threshold
