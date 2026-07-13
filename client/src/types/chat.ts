/**
 * 聊天消息类型
 */
export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  isTyping?: boolean;
  /** V8: 打字机已显示字符数（undefined = 未启动打字机；0 = 刚开始；text.length = 全部显示） */
  displayedLen?: number;
  timestamp: number;
}
