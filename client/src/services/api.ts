/**
 * REST API 调用封装
 */
import type {
  CreateSessionResponse,
  SessionHistoryResponse,
  DestroySessionResponse,
} from '../types/events';

const API_BASE = '/api';

async function request<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${url}`, {
    headers: {
      'Content-Type': 'application/json',
    },
    ...options,
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`HTTP ${response.status}: ${text}`);
  }

  return response.json();
}

/**
 * 创建新会话
 */
export async function createSession(): Promise<CreateSessionResponse> {
  return request<CreateSessionResponse>('/session/create', {
    method: 'POST',
  });
}

/**
 * 获取会话对话历史
 */
export async function getHistory(token: string): Promise<SessionHistoryResponse> {
  return request<SessionHistoryResponse>(`/session/${token}/history`);
}

/**
 * 销毁会话
 */
export async function destroySession(token: string): Promise<DestroySessionResponse> {
  return request<DestroySessionResponse>(`/session/${token}`, {
    method: 'DELETE',
  });
}
