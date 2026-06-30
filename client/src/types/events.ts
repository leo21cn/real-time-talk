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

export type ServerEvent =
  | ServerConnected
  | ServerStateChange
  | ServerSegmentReady
  | ServerBubbleChar
  | ServerBubbleDismiss
  | ServerPlayAnalysis
  | ServerAllCompleted
  | ServerReturnToIdle
  | ServerError;

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
