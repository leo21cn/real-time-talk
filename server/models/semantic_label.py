"""
语义标签枚举与过渡规则
"""
from enum import StrEnum
from typing import List, Set


class SemanticLabel(StrEnum):
    """11 种语义标签"""
    GREETING = "greeting"
    INTRODUCTION = "introduction"
    EXPLAINING = "explaining"
    LISTING = "listing"
    EMPHASIS = "emphasis"
    EXAMPLE = "example"
    ANALYSIS = "analysis"
    COMPARISON = "comparison"
    TRANSITION = "transition"
    CONCLUSION = "conclusion"
    THANKS = "thanks"


# 标签分类（基于 clips.toml 的 opening/body/closing 规则）
OPENING_TAGS: Set[str] = {"greeting", "introduction"}
BODY_TAGS: Set[str] = {"explaining", "listing", "emphasis", "example", "analysis", "comparison"}
CLOSING_TAGS: Set[str] = {"transition", "conclusion", "thanks"}

# 所有合法标签
ALL_LABELS: Set[str] = set(SemanticLabel.__members__.values())  # pyright: ignore[reportArgumentType]


def validate_labels(labels: List[str]) -> List[str]:
    """
    验证标签序列是否符合 opening → body → closing 的过渡规则。
    如不合法，进行过滤/重排确保合理过渡。
    返回合法的标签序列。
    """
    # 过滤掉无效标签
    valid = [l for l in labels if l in ALL_LABELS]
    if not valid:
        return []

    result: List[str] = []

    # 按 opening → body → closing 顺序分组
    openings = [l for l in valid if l in OPENING_TAGS]
    bodies = [l for l in valid if l in BODY_TAGS]
    closings = [l for l in valid if l in CLOSING_TAGS]

    result.extend(openings)
    result.extend(bodies)
    result.extend(closings)

    # 确保 analysis 在 thinking/bridging 状态可用（单独保留）
    if "analysis" in valid and "analysis" not in result:
        result.append("analysis")

    return result if result else valid


def parse_labels_from_text(text: str) -> List[str]:
    """
    从 LLM 返回的文本中解析标签列表。
    支持逗号、空格分隔，忽略其他内容。
    """
    # 清理文本，提取可能的标签
    text = text.strip().lower()
    # 尝试按常见分隔符拆分
    parts = []
    for sep in [",", "，", " "]:
        if sep in text:
            parts = [p.strip() for p in text.replace(sep, ",").split(",")]
            break
    if not parts:
        parts = [text]

    # 匹配已知标签
    labels = [p for p in parts if p in ALL_LABELS]
    return labels if labels else [text]  # 解析失败返回原文
