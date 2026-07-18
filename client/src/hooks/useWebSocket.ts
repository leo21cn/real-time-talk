/**
 * WebSocket 连接管理 Hook
 *
 * 功能:
 * - 建立/断开 WebSocket 连接
 * - 自动重连（exponential backoff: 1s→2s→4s→8s，max 30s）
 * - Token 过期时重新创建 Session
 * - 消息收发与事件回调注册
 */
import { useRef, useCallback, useEffect, useMemo } from 'react';
import type { ClientMessage, ServerEvent } from '../types/events';
import { createSession } from '../services/api';

const SESSION_STORAGE_KEY = 'rt_session';

// 重连配置
const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30000;
const RECONNECT_MULTIPLIER = 2;

interface UseWebSocketOptions {
  onEvent: (event: ServerEvent) => void;
  onDisconnect?: () => void;
}

interface UseWebSocketReturn {
  sendMessage: (text: string) => void;
  sendAck: (segmentIndex: number) => void;
  sendCancel: () => void;
  isConnected: () => boolean;
  getToken: () => string | null;
}

export function useWebSocket(options: UseWebSocketOptions): UseWebSocketReturn {
  const { onEvent, onDisconnect } = options;

  const wsRef = useRef<WebSocket | null>(null);
  const tokenRef = useRef<string | null>(null);
  const reconnectAttemptRef = useRef<number>(0);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const intentionalCloseRef = useRef<boolean>(false);
  const callbacksRef = useRef(options);
  callbacksRef.current = options;

  // 获取或创建 Token
  const ensureToken = useCallback(async (): Promise<string | null> => {
    // 先从 sessionStorage 恢复
    let token = sessionStorage.getItem(SESSION_STORAGE_KEY);
    if (token) {
      tokenRef.current = token;
      return token;
    }

    // 创建新 Session
    try {
      const resp = await createSession();
      token = resp.session_token;
      sessionStorage.setItem(SESSION_STORAGE_KEY, token);
      tokenRef.current = token;
      return token;
    } catch (err) {
      console.error('创建 Session 失败:', err);
      return null;
    }
  }, []);

  // 建立 WebSocket 连接
  const connect = useCallback(async () => {
    const token = await ensureToken();
    if (!token) return;

    // 构建 WebSocket URL
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const host = window.location.host;
    const wsUrl = `${protocol}//${host}/ws?token=${encodeURIComponent(token)}`;

    try {
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.onopen = () => {
        console.log('WebSocket 已连接');
        reconnectAttemptRef.current = 0;
      };

      ws.onmessage = (event) => {
        try {
          const data: ServerEvent = JSON.parse(event.data);
          callbacksRef.current.onEvent(data);
        } catch (err) {
          console.warn('WebSocket 消息解析失败:', err);
        }
      };

      ws.onclose = (event) => {
        console.log(`WebSocket 已断开 (code=${event.code})`);
        wsRef.current = null;

        if (intentionalCloseRef.current) {
          intentionalCloseRef.current = false;
          return;
        }

        callbacksRef.current.onDisconnect?.();

        // 自动重连
        scheduleReconnect();
      };

      ws.onerror = (err) => {
        console.error('WebSocket 错误:', err);
      };
    } catch (err) {
      console.error('WebSocket 连接失败:', err);
      scheduleReconnect();
    }
  }, [ensureToken]);

  // 重连调度
  const scheduleReconnect = useCallback(() => {
    if (intentionalCloseRef.current) return;

    const attempt = reconnectAttemptRef.current;
    const delay = Math.min(
      RECONNECT_BASE_MS * Math.pow(RECONNECT_MULTIPLIER, attempt),
      RECONNECT_MAX_MS,
    );

    console.log(`WebSocket 将在 ${delay}ms 后重连 (attempt ${attempt + 1})`);

    reconnectTimerRef.current = setTimeout(() => {
      reconnectAttemptRef.current++;
      connect();
    }, delay);
  }, [connect]);

  // 发送消息
  const send = useCallback((message: ClientMessage) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(message));
    } else {
      console.warn('WebSocket 未连接，无法发送消息');
    }
  }, []);

  const sendMessage = useCallback((text: string) => {
    send({ type: 'user_message', text });
  }, [send]);

  const sendAck = useCallback((segmentIndex: number) => {
    send({ type: 'ack_played', segment_index: segmentIndex });
  }, [send]);

  const sendCancel = useCallback(() => {
    send({ type: 'cancel' });
  }, [send]);

  const isConnected = useCallback((): boolean => {
    return wsRef.current?.readyState === WebSocket.OPEN;
  }, []);

  const getToken = useCallback((): string | null => {
    return tokenRef.current;
  }, []);

  // 生命周期
  useEffect(() => {
    connect();

    return () => {
      intentionalCloseRef.current = true;
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
      }
      if (wsRef.current) {
        wsRef.current.close();
      }
    };
  }, [connect]);

  // V41: useMemo 稳定返回对象，让依赖 ws 对象的 useCallback（如 App.handleSend）
  // 在父组件重渲染时不会重建，从而避免 ChatPanel 收到的 onSend 引用变化。
  return useMemo(() => ({
    sendMessage,
    sendAck,
    sendCancel,
    isConnected,
    getToken,
  }), [sendMessage, sendAck, sendCancel, isConnected, getToken]);
}
