/**
 * WebSocket 事件类型定义
 */

// ─── 前端状态枚举 ───

export enum AppState {
  Idle = 'idle',
  Input = 'input',
  Thinking = 'thinking',
  Speaking = 'speaking',
  Bridging = 'bridging',
}

// ─── 客户端 → 服务端消息 ───

export interface ClientUserMessage {
  type: 'user_message';
  text: string;
}

export interface ClientAckPlayed {
  type: 'ack_played';
  segment_index: number;
}

export interface ClientCancel {
  type: 'cancel';
}

export type ClientMessage = ClientUserMessage | ClientAckPlayed | ClientCancel;

// ─── 服务端 → 客户端事件 ───

export interface ServerConnected {
  type: 'connected';
  session_token: string;
  state: string;
}

export interface ServerStateChange {
  type: 'state_change';
  state: 'thinking' | 'speaking' | 'bridging' | 'idle';
}

export interface ServerSegmentReady {
  type: 'segment_ready';
  index: number;
  video_url: string;
  duration_ms: number;
  text: string;
}

// V6: 段生成任务已启动（视频未生成完成）— 客户端立即启动预加载 fetch（带重试）
export interface ServerSegmentPending {
  type: 'segment_pending';
  index: number;
  video_url: string;
}

export interface ServerBubbleChar {
  type: 'bubble_char';
  char: string;
  segment_index: number;
}

export interface ServerBubbleDismiss {
  type: 'bubble_dismiss';
  segment_index: number;
}

export interface ServerPlayAnalysis {
  type: 'play_analysis';
  loop: boolean;
}

export interface ServerAllCompleted {
  type: 'all_completed';
}

export interface ServerReturnToIdle {
  type: 'return_to_idle';
}

export interface ServerError {
  type: 'error';
  message: string;
}

// V17: 服务端在新一轮 user_message 开始时推送此事件，携带新 msg_seq。
// 客户端记录最新 msg_seq，过滤旧会话的残留 segment_ready（避免取消后还未发出
// 的 R1 segment_ready 被误认为 R2 的段）。
export interface ServerSessionReset {
  type: 'session_reset';
  msg_seq: number;
}

// V20: 服务端所有段推送完毕后发送此事件，告知段数和总时长。
// 客户端据此确认视频播放列表完整，可在最后一段视频结束后切 idle。
export interface ServerResponseComplete {
  type: 'response_complete';
  total_segments: number;
}

export type ServerEvent =
  | ServerConnected
  | ServerStateChange
  | ServerSegmentReady
  | ServerSegmentPending
  | ServerBubbleChar
  | ServerBubbleDismiss
  | ServerPlayAnalysis
  | ServerAllCompleted
  | ServerReturnToIdle
  | ServerError
  | ServerSessionReset
  | ServerResponseComplete;

// ─── API 响应类型 ───

export interface CreateSessionResponse {
  session_token: string;
}

export interface SessionHistoryResponse {
  messages: Array<{
    role: string;
    content: string;
    timestamp: string;
  }>;
  count: number;
}

export interface DestroySessionResponse {
  status: string;
  session_token: string;
}
