import React, { useEffect, useRef, useState } from "react";
import { CHAT_WS_URL } from "../lib/config";

export interface ChatMessage {
  type: "message";
  id: string;
  room: string;
  user_id: string;
  username: string;
  text: string;
  created_at: string;
}

interface ServerEvent {
  type: "history" | "presence" | "error" | "message";
  room?: string;
  messages?: ChatMessage[];
  online?: number;
  message?: string;
  id?: string;
  user_id?: string;
  username?: string;
  text?: string;
  created_at?: string;
}

interface ChatPanelProps {
  room: string;
  token: string | null;
  isAuthenticated: boolean;
}

function formatTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function colorForUser(name: string): string {
  const palette = ["#a855f7", "#38bdf8", "#34d399", "#f472b6", "#facc15", "#fb923c"];
  let hash = 0;
  for (let i = 0; i < name.length; i += 1) {
    hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
  }
  return palette[hash % palette.length];
}

export function ChatPanel({ room, token, isAuthenticated }: ChatPanelProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [online, setOnline] = useState<number>(0);
  const [connected, setConnected] = useState<boolean>(false);
  const [statusError, setStatusError] = useState<string>("");
  const [draft, setDraft] = useState<string>("");

  const wsRef = useRef<WebSocket | null>(null);
  const listEndRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let closedByEffect = false;
    let reconnectTimer: number | null = null;

    const connect = () => {
      if (closedByEffect) return;
      const params = new URLSearchParams({ room });
      if (token) params.set("token", token);

      const ws = new WebSocket(`${CHAT_WS_URL}?${params.toString()}`);
      wsRef.current = ws;

      ws.onopen = () => {
        if (closedByEffect) return;
        setConnected(true);
        setStatusError("");
      };

      ws.onmessage = (event) => {
        if (closedByEffect) return;
        try {
          const data = JSON.parse(event.data) as ServerEvent;
          if (data.type === "history") {
            setMessages(data.messages || []);
            if (typeof data.online === "number") setOnline(data.online);
          } else if (data.type === "presence") {
            if (typeof data.online === "number") setOnline(data.online);
          } else if (data.type === "message" && data.id && data.text) {
            setMessages((prev) => [
              ...prev.slice(-99),
              {
                type: "message",
                id: data.id!,
                room: data.room || room,
                user_id: data.user_id || "",
                username: data.username || "user",
                text: data.text!,
                created_at: data.created_at || new Date().toISOString(),
              },
            ]);
          } else if (data.type === "error" && data.message) {
            setStatusError(data.message);
          }
        } catch {
          // Ignore malformed frame
        }
      };

      ws.onclose = () => {
        if (closedByEffect) return;
        setConnected(false);
        setStatusError("Нет связи с чатом. Переподключение...");
        reconnectTimer = window.setTimeout(connect, 2500);
      };

      ws.onerror = () => {
        ws.close();
      };
    };

    connect();

    return () => {
      closedByEffect = true;
      if (reconnectTimer !== null) window.clearTimeout(reconnectTimer);
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
    };
  }, [room, token]);

  useEffect(() => {
    listEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const sendMessage = (e: React.FormEvent) => {
    e.preventDefault();
    const text = draft.trim();
    if (!text) return;
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
      setStatusError("Чат не подключён");
      return;
    }
    wsRef.current.send(JSON.stringify({ type: "message", text }));
    setDraft("");
    setStatusError("");
  };

  return (
    <aside className="chat-card">
      <div className="chat-header">
        <div>
          <h3>Чат канала</h3>
          <span className="muted">{room}</span>
        </div>
        <div className="chat-meta">
          <span className={`dot ${connected ? "dot-online" : "dot-offline"}`} />
          <span>{connected ? `${online} в чате` : "офлайн"}</span>
        </div>
      </div>

      <div className="chat-messages">
        {messages.length === 0 ? (
          <div className="chat-empty">Сообщений пока нет. Напишите первым!</div>
        ) : (
          messages.map((msg) => (
            <div key={msg.id} className="chat-msg">
              <span className="chat-time">{formatTime(msg.created_at)}</span>{" "}
              <strong style={{ color: colorForUser(msg.username) }}>{msg.username}:</strong>{" "}
              <span className="chat-text">{msg.text}</span>
            </div>
          ))
        )}
        <div ref={listEndRef} />
      </div>

      {statusError && <div className="chat-error">{statusError}</div>}

      <form className="chat-form" onSubmit={sendMessage}>
        <input
          type="text"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={isAuthenticated ? "Написать сообщение..." : "Войдите, чтобы писать в чат"}
          disabled={!isAuthenticated || !connected}
          maxLength={500}
        />
        <button
          type="submit"
          className="btn-primary"
          disabled={!isAuthenticated || !connected || !draft.trim()}
        >
          Отправить
        </button>
      </form>
    </aside>
  );
}
