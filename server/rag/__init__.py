"""
RAG（检索增强生成）模块

功能：
- 文本分块（chunking）
- 上下文构建（从检索结果构建 system 消息）
"""


def chunk_text(text: str, max_chars: int = 500, overlap: int = 100) -> list[str]:
    """
    将长文本切分为重叠的块。

    Args:
        text: 原始文本
        max_chars: 每块最大字符数
        overlap: 块间重叠字符数

    Returns:
        文本块列表
    """
    if len(text) <= max_chars:
        return [text]

    chunks = []
    # 尝试按段落切分
    paragraphs = text.split("\n\n")

    current = ""
    for para in paragraphs:
        para = para.strip()
        if not para:
            continue

        if len(current) + len(para) + 1 <= max_chars:
            current = (current + "\n\n" + para).strip() if current else para
        else:
            if current:
                chunks.append(current)
            # 若单段落仍超过 max_chars，按字符窗口切分
            if len(para) > max_chars:
                for i in range(0, len(para), max_chars - overlap):
                    chunk = para[i:i + max_chars]
                    if chunk.strip():
                        chunks.append(chunk.strip())
                current = ""
            else:
                current = para

    if current:
        chunks.append(current)

    return chunks if chunks else [text]


def build_rag_context(search_results: list[dict]) -> str:
    """
    将检索结果构建为可注入 LLM 的上下文文本。

    Args:
        search_results: Qdrant 返回的 [{"score": float, "payload": {"text": str, "source": str}, "collection": str}]

    Returns:
        格式化的上下文字符串（若无结果则返回空字符串）
    """
    if not search_results:
        return ""

    # 过滤低分结果（余弦距离 > 0.7 意味着不太相关）
    relevant = [r for r in search_results if r["score"] >= 0.3]

    if not relevant:
        return ""

    lines = ["[以下是知识库中与用户问题相关的参考内容，请优先基于这些内容回答]"]
    for i, item in enumerate(relevant, 1):
        text = item["payload"].get("text", "").strip()
        source = item["payload"].get("source", "")
        source_suffix = f"（来源: {source}）" if source else ""
        lines.append(f"参考{i}: {text}{source_suffix}")

    return "\n".join(lines)
