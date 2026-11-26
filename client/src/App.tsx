import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  getMyStream,
  listStreams,
  login,
  me,
  register,
  type MyStream,
  type PublicStream,
  type User,
} from "./api";
import { BroadcastPanel } from "./components/BroadcastPanel";
import { ChatPanel } from "./components/ChatPanel";
import { VideoPlayer } from "./components/VideoPlayer";
import { normalizeStreamPath } from "./lib/config";
import "./App.css";

type AuthMode = "login" | "register";

function App() {
  const [authMode, setAuthMode] = useState<AuthMode>("login");
  const [showAuthModal, setShowAuthModal] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [token, setToken] = useState<string | null>(() => localStorage.getItem("token"));
  const [user, setUser] = useState<User | null>(null);
  const [myStream, setMyStream] = useState<MyStream | null>(null);
  const [authError, setAuthError] = useState("");
  const [authNotice, setAuthNotice] = useState("");
  const [authBusy, setAuthBusy] = useState(false);

  const [activePath, setActivePath] = useState<string>("live/stream");
  const [customPath, setCustomPath] = useState<string>("live/stream");
  const [streams, setStreams] = useState<PublicStream[]>([]);
  const [mediamtxOnline, setMediamtxOnline] = useState<boolean>(false);
  const userSelectedChannelRef = useRef(false);

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    me()
      .then((u) => {
        if (cancelled) return;
        setUser(u);
        return getMyStream().then((s) => {
          if (!cancelled) setMyStream(s);
        });
      })
      .catch(() => {
        if (cancelled) return;
        localStorage.removeItem("token");
        setToken(null);
        setUser(null);
        setMyStream(null);
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  const activeUser = token ? user : null;
  const activeMyStream = token ? myStream : null;

  useEffect(() => {
    let cancelled = false;
    const poll = () => {
      listStreams()
        .then((res) => {
          if (cancelled) return;
          setMediamtxOnline(res.mediamtx_online);
          setStreams(res.streams);
        })
        .catch(() => {
          if (!cancelled) setMediamtxOnline(false);
        });
    };
    poll();
    const timer = window.setInterval(poll, 4000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  const activeMeta = useMemo(() => {
    const found = streams.find((s) => s.path === activePath);
    if (found) return found;
    if (activeMyStream && activeMyStream.path === activePath) {
      return {
        path: activeMyStream.path,
        stream_key: activeMyStream.stream_key,
        title: activeMyStream.title,
        owner_email: activeUser?.email ?? null,
        mode: activeMyStream.mode,
        ready: false,
        ready_time: null,
        tracks: [],
        readers_count: 0,
        bytes_received: 0,
        whep_url: activeMyStream.whep_url,
        hls_url: activeMyStream.hls_url,
      };
    }
    return undefined;
  }, [streams, activePath, activeMyStream, activeUser?.email]);

  const submitAuth = async (e: React.FormEvent) => {
    e.preventDefault();
    setAuthError("");
    setAuthNotice("");
    setAuthBusy(true);
    try {
      if (authMode === "register") {
        await register(email, password);
        setAuthNotice("Аккаунт создан, выполняем вход...");
      }
      const { access_token } = await login(email, password);
      localStorage.setItem("token", access_token);
      setToken(access_token);
      setShowAuthModal(false);
      setPassword("");
    } catch (err) {
      setAuthError(err instanceof Error ? err.message : "Ошибка авторизации");
    } finally {
      setAuthBusy(false);
    }
  };

  const logout = () => {
    localStorage.removeItem("token");
    setToken(null);
    setUser(null);
    setMyStream(null);
    setPassword("");
  };

  useEffect(() => {
    if (userSelectedChannelRef.current) return;
    const currentStream = streams.find((s) => s.path === activePath);
    if (currentStream?.ready) return;

    const myReady = activeMyStream
      ? streams.find((s) => s.path === activeMyStream.path && s.ready)
      : undefined;
    const firstReady = myReady ?? streams.find((s) => s.ready);
    if (firstReady && firstReady.path !== activePath) {
      setActivePath(firstReady.path);
      setCustomPath(firstReady.path);
    }
  }, [streams, activePath, activeMyStream]);

  const selectChannel = (path: string) => {
    userSelectedChannelRef.current = true;
    const clean = normalizeStreamPath(path);
    setActivePath(clean);
    setCustomPath(clean);
  };

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand-group">
          <span className="brand">TWICH-ANALOG</span>
          <span className={`pill ${mediamtxOnline ? "pill-ok" : "pill-warn"}`}>
            MediaMTX: {mediamtxOnline ? "онлайн" : "не запущен"}
          </span>
        </div>

        <form
          className="channel-search"
          onSubmit={(e) => {
            e.preventDefault();
            selectChannel(customPath);
          }}
        >
          <input
            type="text"
            value={customPath}
            onChange={(e) => setCustomPath(e.target.value)}
            placeholder="Путь канала, например live/stream"
          />
          <button type="submit" className="btn-secondary">
            Открыть
          </button>
        </form>

        <div className="auth-controls">
          {activeUser ? (
            <>
              {activeMyStream && (
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={() => selectChannel(activeMyStream.path)}
                >
                  Мой канал
                </button>
              )}
              <span className="user-email">{activeUser.email}</span>
              <button type="button" className="btn-secondary" onClick={logout}>
                Выйти
              </button>
            </>
          ) : (
            <button
              type="button"
              className="btn-primary"
              onClick={() => {
                setAuthError("");
                setAuthNotice("");
                setShowAuthModal(true);
              }}
            >
              Войти / Регистрация
            </button>
          )}
        </div>
      </header>

      <div className="channels-strip">
        <span className="muted">Каналы:</span>
        {streams.map((s) => (
          <button
            key={s.path}
            type="button"
            className={`channel-chip ${activePath === s.path ? "active" : ""}`}
            onClick={() => selectChannel(s.path)}
          >
            <span className={`dot ${s.ready ? "dot-online" : "dot-offline"}`} />
            <span>{s.title}</span>
            <small>{s.path}</small>
          </button>
        ))}
        {activeMyStream && !streams.some((s) => s.path === activeMyStream.path) && (
          <button
            type="button"
            className={`channel-chip ${activePath === activeMyStream.path ? "active" : ""}`}
            onClick={() => selectChannel(activeMyStream.path)}
          >
            <span className="dot dot-offline" />
            <span>{activeMyStream.title}</span>
            <small>{activeMyStream.path}</small>
          </button>
        )}
      </div>

      <main className="workspace">
        <div className="stage-column">
          <VideoPlayer key={activePath} streamPath={activePath} streamMeta={activeMeta} />
          <BroadcastPanel
            myStream={activeMyStream}
            onStreamUpdated={setMyStream}
            onWatchChannel={selectChannel}
          />
        </div>
        <div className="chat-column">
          <ChatPanel
            key={`${activePath}:${token ?? ""}`}
            room={activePath}
            token={token}
            isAuthenticated={Boolean(activeUser)}
          />
        </div>
      </main>

      {showAuthModal && (
        <div className="modal-backdrop" onClick={() => setShowAuthModal(false)}>
          <form
            className="auth-modal"
            onClick={(e) => e.stopPropagation()}
            onSubmit={submitAuth}
          >
            <div className="modal-head">
              <h2>{authMode === "login" ? "Вход в аккаунт" : "Регистрация"}</h2>
              <button
                type="button"
                className="btn-secondary"
                onClick={() => setShowAuthModal(false)}
              >
                ✕
              </button>
            </div>

            <div className="segmented" style={{ width: "100%" }}>
              <button
                type="button"
                className={authMode === "login" ? "active" : ""}
                onClick={() => {
                  setAuthMode("login");
                  setAuthError("");
                  setAuthNotice("");
                }}
              >
                Вход
              </button>
              <button
                type="button"
                className={authMode === "register" ? "active" : ""}
                onClick={() => {
                  setAuthMode("register");
                  setAuthError("");
                  setAuthNotice("");
                }}
              >
                Регистрация
              </button>
            </div>

            <label>
              Email
              <input
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="name@example.com"
              />
            </label>

            <label>
              Пароль, от 8 символов
              <input
                type="password"
                required
                minLength={8}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
              />
            </label>

            {authError && <p className="status-err">{authError}</p>}
            {authNotice && !authError && <p className="status-ok">{authNotice}</p>}

            <button type="submit" className="btn-primary" disabled={authBusy}>
              {authBusy
                ? "Подождите..."
                : authMode === "login"
                  ? "Войти"
                  : "Создать аккаунт"}
            </button>
          </form>
        </div>
      )}
    </div>
  );
}

export default App;
