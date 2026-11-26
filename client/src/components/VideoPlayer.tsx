import { useEffect, useRef, useState } from "react";
import Hls from "hls.js";
import type { PublicStream } from "../api";
import { hlsUrl, whepUrl } from "../lib/config";
import { startWhepPlayer, type WhepSession } from "../lib/webrtc";

type PlaybackMode = "whep" | "hls";

interface VideoPlayerProps {
  streamPath: string;
  streamMeta?: PublicStream;
}

function formatBytes(bytes: number): string {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let val = bytes;
  let i = 0;
  while (val >= 1024 && i < units.length - 1) {
    val /= 1024;
    i += 1;
  }
  return `${val.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

export function VideoPlayer({ streamPath, streamMeta }: VideoPlayerProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [protocol, setProtocol] = useState<PlaybackMode>("whep");
  const [statusText, setStatusText] = useState("Подключение к потоку...");
  const [isPlaying, setIsPlaying] = useState(false);
  const [isMuted, setIsMuted] = useState(true);
  const isMutedRef = useRef(isMuted);
  const [retryTick, setRetryTick] = useState(0);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    let cancelled = false;
    let whepSession: WhepSession | null = null;
    let hlsInstance: Hls | null = null;
    let retryTimer: number | null = null;

    const scheduleRetry = (reason: string) => {
      if (cancelled) return;
      setIsPlaying(false);
      setStatusText(reason);
      if (retryTimer !== null) window.clearTimeout(retryTimer);
      retryTimer = window.setTimeout(() => {
        if (!cancelled) setRetryTick((t) => t + 1);
      }, 3000);
    };

    const cleanup = () => {
      if (retryTimer !== null) {
        window.clearTimeout(retryTimer);
        retryTimer = null;
      }
      if (hlsInstance) {
        hlsInstance.destroy();
        hlsInstance = null;
      }
      if (whepSession) {
        void whepSession.close();
        whepSession = null;
      }
      video.srcObject = null;
      video.removeAttribute("src");
    };

    if (protocol === "whep") {
      startWhepPlayer(
        whepUrl(streamPath),
        (remoteStream) => {
          if (cancelled) return;
          video.srcObject = remoteStream;
          video.muted = isMutedRef.current;
          void video
            .play()
            .then(() => {
              if (!cancelled) {
                setIsPlaying(true);
                setStatusText("В эфире");
              }
            })
            .catch(() => {
              if (!cancelled) {
                setIsPlaying(true);
                setStatusText("Нажмите Play на плеере");
              }
            });
        },
        (state) => {
          if (cancelled) return;
          if (state === "connected") {
            setIsPlaying(true);
            setStatusText("В эфире");
          } else if (state === "failed" || state === "disconnected") {
            scheduleRetry("Поток офлайн или оборвался — повтор через 3 с...");
          }
        },
      )
        .then((session) => {
          if (cancelled) {
            void session.close();
            return;
          }
          whepSession = session;
        })
        .catch(() => {
          scheduleRetry("Поток офлайн — ждём публикацию...");
        });
    } else {
      const src = hlsUrl(streamPath);
      if (Hls.isSupported()) {
        hlsInstance = new Hls({
          lowLatencyMode: true,
          liveSyncDurationCount: 1,
          liveMaxLatencyDurationCount: 2,
          maxBufferLength: 2,
          maxLiveSyncPlaybackRate: 1.5,
        });
        hlsInstance.loadSource(src);
        hlsInstance.attachMedia(video);
        hlsInstance.on(Hls.Events.MANIFEST_PARSED, () => {
          if (cancelled) return;
          video.muted = isMutedRef.current;
          void video.play().catch(() => {});
          setIsPlaying(true);
          setStatusText("В эфире");
        });
        hlsInstance.on(Hls.Events.ERROR, (_evt, data) => {
          if (data.fatal) {
            hlsInstance?.destroy();
            hlsInstance = null;
            scheduleRetry("HLS поток недоступен — повтор через 3 с...");
          }
        });
      } else if (video.canPlayType("application/vnd.apple.mpegurl")) {
        video.src = src;
        video.muted = isMutedRef.current;
        void video
          .play()
          .then(() => {
            if (!cancelled) {
              setIsPlaying(true);
              setStatusText("В эфире");
            }
          })
          .catch(() => {
            scheduleRetry("HLS поток недоступен — повтор через 3 с...");
          });
      } else {
        setStatusText("Браузер не поддерживает HLS — используйте WebRTC");
      }
    }

    return () => {
      cancelled = true;
      cleanup();
    };
  }, [streamPath, protocol, retryTick]);

  useEffect(() => {
    isMutedRef.current = isMuted;
    if (videoRef.current) {
      videoRef.current.muted = isMuted;
    }
  }, [isMuted]);

  const toggleFullscreen = () => {
    const el = videoRef.current;
    if (!el) return;
    if (document.fullscreenElement) {
      void document.exitFullscreen();
    } else {
      void el.requestFullscreen?.();
    }
  };

  return (
    <section className="player-card">
      <div className="player-header">
        <div className="player-title-row">
          <span
            className={`badge ${isPlaying || streamMeta?.ready ? "badge-live" : "badge-offline"}`}
          >
            {isPlaying || streamMeta?.ready ? "LIVE" : "OFFLINE"}
          </span>
          <div>
            <h2 className="player-title">{streamMeta?.title || `Канал ${streamPath}`}</h2>
            <p className="player-subtitle">
              Путь: <code>{streamPath}</code>
              {streamMeta?.owner_email ? ` · Стример: ${streamMeta.owner_email}` : ""}
            </p>
          </div>
        </div>

        <div className="player-controls">
          <div className="segmented">
            <button
              type="button"
              className={protocol === "whep" ? "active" : ""}
              onClick={() => setProtocol("whep")}
            >
              WebRTC
            </button>
            <button
              type="button"
              className={protocol === "hls" ? "active" : ""}
              onClick={() => setProtocol("hls")}
            >
              HLS
            </button>
          </div>
          <button
            type="button"
            className="btn-secondary"
            onClick={() => setIsMuted((m) => !m)}
          >
            {isMuted ? "Включить звук" : "Выключить звук"}
          </button>
          <button
            type="button"
            className="btn-secondary"
            onClick={() => setRetryTick((t) => t + 1)}
          >
            Обновить
          </button>
          <button type="button" className="btn-secondary" onClick={toggleFullscreen}>
            На весь экран
          </button>
        </div>
      </div>

      <div className="video-wrapper">
        <video
          ref={videoRef}
          autoPlay
          playsInline
          controls
          muted={isMuted}
          className="video-element"
        />
        {!isPlaying && (
          <div className="video-overlay">
            <p>{statusText}</p>
            <span className="hint">
              Запустите OBS на <code>{streamPath}</code> или нажмите «Начать демку экрана» ниже.
            </span>
          </div>
        )}
      </div>

      <div className="player-metrics">
        <span>Статус: {statusText}</span>
        <span>Зрители: {streamMeta?.readers_count ?? 0}</span>
        <span>Кодеки: {streamMeta?.tracks?.length ? streamMeta.tracks.join(", ") : "—"}</span>
        <span>Принято: {formatBytes(streamMeta?.bytes_received ?? 0)}</span>
      </div>
    </section>
  );
}
