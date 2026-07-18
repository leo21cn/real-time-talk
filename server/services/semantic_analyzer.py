"""
语义分析模块：通过 LLM 分析文本的语义结构，输出标签序列
"""
import logging
from typing import List

from server.models.semantic_label import parse_labels_from_text, validate_labels
from server.services.llm_client import LlmClient, LlmClientError

logger = logging.getLogger(__name__)

# 语义分析 Prompt
SEMANTIC_ANALYSIS_PROMPT = """分析以下文本的语义结构，输出对应的标签序列。
可选标签（仅输出标签名，逗号分隔）：
  greeting - 问候开场
  introduction - 引入主题
  explaining - 解释说明
  listing - 列举分点
  emphasis - 强调重点
  example - 举例说明
  analysis - 深度分析/思考
  comparison - 对比分析
  transition - 过渡转换
  conclusion - 总结收尾
  thanks - 致谢结束

请严格按照 opening(heading,introduction) → body(explaining,listing,emphasis,example,analysis,comparison) → closing(transition,conclusion,thanks) 的顺序输出标签。

文本：
{text}

标签序列："""


class SemanticAnalyzer:
    """语义分析器：分析文本 → 输出标签序列"""

    def __init__(self, llm_client: LlmClient):
        self.llm = llm_client

    async def analyze(self, text: str, skip_llm: bool = False) -> List[str]:
        """
        分析文本语义结构，返回标签序列。

        Args:
            text: 待分析的文本段落
            skip_llm: 是否跳过 LLM 调用，直接使用关键词回退（首段优化）

        Returns:
            标签列表，如 ["introduction", "explaining", "emphasis"]
        """
        if not text.strip():
            return ["explaining"]  # 空文本默认标签

        # 首段优化：跳过 LLM，直接关键词回退（节省 2-6 秒）
        if skip_llm:
            logger.info(f"语义分析(首段回退): {text[:50]}...")
            return self._fallback_analyze(text)

        prompt = SEMANTIC_ANALYSIS_PROMPT.format(text=text)
        messages = [{"role": "user", "content": prompt}]

        try:
            # 使用较小的 max_tokens（标签序列很短）
            response = await self.llm.chat(messages, max_tokens=100)
            logger.info(f"语义分析原始返回: {response}")

            labels = parse_labels_from_text(response)

            # 如果解析失败，尝试直接用 response 作为标签
            if not labels or labels == [response]:
                # 回退：基于关键词简单匹配
                labels = self._fallback_analyze(text)

            # 验证/重排标签序列
            validated = validate_labels(labels)
            logger.info(f"语义分析结果: {validated}")

            return validated if validated else ["explaining"]

        except LlmClientError as e:
            logger.warning(f"语义分析 LLM 调用失败，使用回退分析: {e}")
            return self._fallback_analyze(text)
        except Exception as e:
            logger.error(f"语义分析异常: {e}")
            return self._fallback_analyze(text)

    def _fallback_analyze(self, text: str) -> List[str]:
        """回退方案：基于关键词的简单语义匹配"""
        text_lower = text.lower()
        labels = []

        # opening
        if any(kw in text_lower for kw in ["你好", "嗨", "欢迎", "hello", "hi", "大家好", "各位"]):
            labels.append("greeting")
        if any(kw in text_lower for kw in ["今天", "聊一聊", "关于", "话题", "介绍", "分享", "探讨", "讨论", "讲解", "讲一讲", "说说", "谈一谈"]):
            labels.append("introduction")

        # body
        if any(kw in text_lower for kw in ["第一", "首先", "其次", "另外", "此外", "最后", "1.", "2.", "一、", "二、", "三、", "一是", "二是", "三是", "一方面", "另一方面"]):
            labels.append("listing")
        if any(kw in text_lower for kw in ["关键", "重要", "必须", "核心", "注意", "重点", "切记", "记住", "特别", "尤其", "值得"]):
            labels.append("emphasis")
        if any(kw in text_lower for kw in ["例如", "比如", "举例", "例子", "打个比方", "像", "譬如", "案例", "实例"]):
            labels.append("example")
        if any(kw in text_lower for kw in ["对比", "相比", "差异", "优劣", "区别", "不同", "比较", "两者", "左边", "右边"]):
            labels.append("comparison")
        if any(kw in text_lower for kw in ["分析", "原因", "本质", "深层", "深入", "思考", "反思", "探究", "挖掘"]):
            labels.append("analysis")
        if any(kw in text_lower for kw in ["概念", "意思", "指", "定义", "解释", "说明", "描述", "所谓", "即", "简单来说", "通俗", "理解"]):
            labels.append("explaining")

        # closing
        if any(kw in text_lower for kw in ["接下来", "下面", "还有", "接着", "然后", "另外还有", "除此之外", "再来看"]):
            labels.append("transition")
        if any(kw in text_lower for kw in ["总结", "综上", "回顾", "归纳", "总而言之", "总的来说", "概括", "一句话", "简而言之", "最后总结"]):
            labels.append("conclusion")
        if any(kw in text_lower for kw in ["谢谢", "感谢", "欢迎交流", "期待", "下次", "再见", "拜拜", "再会"]):
            labels.append("thanks")

        # 默认至少一个 explaining
        if not labels:
            labels = ["explaining"]

        # V49: 单标签时尝试追加互补 body 标签，增加视频剪辑多样性
        body_labels = {"explaining", "listing", "emphasis", "example", "comparison", "analysis"}
        if len(labels) == 1 and labels[0] in body_labels:
            # 从其余 body 类别中尝试匹配关键词
            extra_checks = [
                ("emphasis", ["关键", "重要", "必须", "核心", "注意", "重点", "特别", "尤其", "值得"]),
                ("example", ["例如", "比如", "举例", "例子", "打个比方", "像", "譬如", "案例", "实例"]),
                ("listing", ["第一", "首先", "其次", "另外", "此外", "最后", "一是", "二是", "三是", "一方面", "另一方面"]),
                ("explaining", ["概念", "意思", "指", "定义", "解释", "说明", "描述", "所谓", "简单来说"]),
                ("comparison", ["对比", "相比", "差异", "优劣", "区别", "不同", "比较"]),
            ]
            for candidate_label, kws in extra_checks:
                if candidate_label != labels[0] and any(kw in text_lower for kw in kws):
                    labels.append(candidate_label)
                    break

        return validate_labels(labels)
