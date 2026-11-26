import { useEffect, useState } from "react";
import {
  obsConfigure,
  obsConnect,
  obsMonitorDemo,
  obsStartStream,
  obsStatus,
  obsStopStream,
  obsSwitchScene,
  rotateMyStreamKey,
  updateMyStream,
  type MyStream,
  type OBSStatus,
} from "../api";

interface BroadcastPanelProps {
  myStream: MyStream | null;
  onStreamUpdated: (stream: MyStream) => void;
  onWatchChannel: (path: string) => void;
}

export function BroadcastPanel({
  myStream,
  onStreamUpdated,
  onWatchChannel,
}: BroadcastPanelProps) {
  const [draftTitle, setDraftTitle] = useState<string | null>(null);
  const [savingTitle, setSavingTitle] = useState(false);

  const titleInput = draftTitle ?? myStream?.title ?? "";

  const [obsHost, setObsHost] = useState("127.0.0.1");
  const [obsPort, setObsPort] = useState(4455);
  const [obsPassword, setObsPassword] = useState("");
  const [obs, setObs] = useState<OBSStatus | null>(null);
  const [obsBusy, setObsBusy] = useState(false);
  const [obsMsg, setObsMsg] = useState("");
  const [obsError, setObsError] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [copied, setCopied] = useState("");

  useEffect(() => {
    if (!myStream) return;
    void obsStatus()
      .then(setObs)
      .catch(() => {});
  }, [myStream]);

  if (!myStream) {
    return (
      <section className="panel-card">
        <h3>Выйти в эфир (OBS)</h3>
        <p className="muted">
          Войдите в аккаунт вверху страницы, чтобы подключить OBS и управлять трансляцией.
        </p>
      </section>
    );
  }

  const saveTitle = async () => {
    const trimmed = titleInput.trim();
    if (!trimmed) return;
    setSavingTitle(true);
    try {
      const updated = await updateMyStream({
        title: trimmed,
        mode: "obs",
      });
      setDraftTitle(null);
      onStreamUpdated(updated);
    } finally {
      setSavingTitle(false);
    }
  };

  const copyText = async (label: string, value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(label);
      window.setTimeout(() => setCopied(""), 1500);
    } catch {
      // Ignore clipboard errors
    }
  };

  const handleRotateKey = async () => {
    const updated = await rotateMyStreamKey();
    onStreamUpdated(updated);
  };

  const handleObsConnect = async () => {
    setObsBusy(true);
    setObsMsg("");
    setObsError("");
    try {
      const status = await obsConnect({
        host: obsHost,
        port: Number(obsPort) || 4455,
        password: obsPassword,
      });
      setObs(status);
      if (status.connected) {
        setObsMsg("OBS подключён!");
      } else if (status.error) {
        setObsError(status.error);
      }
    } catch (err) {
      setObsError(err instanceof Error ? err.message : "Ошибка подключения к OBS");
    } finally {
      setObsBusy(false);
    }
  };

  const handleObsAction = async (
    fn: () => Promise<OBSStatus>,
    successMsg: string,
    watchAfter = false,
  ) => {
    setObsBusy(true);
    setObsMsg("");
    setObsError("");
    try {
      const status = await fn();
      setObs(status);
      setObsMsg(successMsg);
      if (watchAfter) {
        onWatchChannel(myStream.path);
      }
    } catch (err) {
      setObsError(err instanceof Error ? err.message : "Ошибка команды OBS");
    } finally {
      setObsBusy(false);
    }
  };

  return (
    <section className="panel-card">
      <div className="panel-top">
        <div>
          <h3>Студия OBS</h3>
          <p className="muted">
            Ваш канал: <code>{myStream.path}</code>{" "}
            <button
              type="button"
              className="link-btn"
              onClick={() => onWatchChannel(myStream.path)}
            >
              Открыть в плеере
            </button>
          </p>
        </div>
      </div>

      <div className="stream-title-bar">
        <input
          type="text"
          value={titleInput}
          onChange={(e) => setDraftTitle(e.target.value)}
          placeholder="Название трансляции"
          maxLength={140}
        />
        <button
          type="button"
          className="btn-secondary"
          disabled={savingTitle}
          onClick={() => void saveTitle()}
        >
          {savingTitle ? "Сохранение..." : "Сохранить название"}
        </button>
      </div>

      <div className="broadcast-body">
        <div className="obs-credentials">
          <div className="cred-row">
            <span>RTMP Сервер:</span>
            <code>{myStream.rtmp_server}</code>
            <button
              type="button"
              className="btn-secondary"
              onClick={() => void copyText("server", myStream.rtmp_server)}
            >
              {copied === "server" ? "Скопировано" : "Копировать"}
            </button>
          </div>
          <div className="cred-row">
            <span>Ключ потока:</span>
            <code>{showKey ? myStream.stream_key : "••••••••••••"}</code>
            <button type="button" className="btn-secondary" onClick={() => setShowKey((s) => !s)}>
              {showKey ? "Скрыть" : "Показать"}
            </button>
            <button
              type="button"
              className="btn-secondary"
              onClick={() => void copyText("key", myStream.stream_key)}
            >
              {copied === "key" ? "Скопировано" : "Копировать"}
            </button>
            <button type="button" className="btn-secondary" onClick={() => void handleRotateKey()}>
              Сменить ключ
            </button>
          </div>
        </div>

        <div className="obs-control-box">
          <h4>Управление OBS</h4>
          <p className="hint">
            В OBS откройте: Инструменты → Настройки сервера WebSocket → Включить сервер WebSocket, порт 4455.
          </p>
          <div className="obs-form-row">
            <input
              type="text"
              value={obsHost}
              onChange={(e) => setObsHost(e.target.value)}
              placeholder="Host"
            />
            <input
              type="number"
              value={obsPort}
              onChange={(e) => setObsPort(Number(e.target.value))}
              placeholder="Port"
              style={{ maxWidth: 110 }}
            />
            <input
              type="password"
              value={obsPassword}
              onChange={(e) => setObsPassword(e.target.value)}
              placeholder="Пароль OBS WebSocket"
            />
            <button
              type="button"
              className="btn-primary"
              disabled={obsBusy}
              onClick={() => void handleObsConnect()}
            >
              {obsBusy ? "..." : "Подключить OBS"}
            </button>
          </div>

          {obs && (
            <div className="obs-status-panel">
              <div className="obs-status-row">
                <span className={`badge ${obs.connected ? "badge-live" : "badge-offline"}`}>
                  {obs.connected ? "OBS ПОДКЛЮЧЁН" : "OBS ОТКЛЮЧЁН"}
                </span>
                {obs.connected && (
                  <span>
                    OBS {obs.obs_version} · Эфир: {obs.streaming ? `идёт · ${obs.stream_timecode || "LIVE"}` : "офлайн"}
                  </span>
                )}
              </div>

              {obs.error && <p className="status-err">{obs.error}</p>}

              {obs.connected && (
                <>
                  <div className="row-actions">
                    <button
                      type="button"
                      className="btn-secondary"
                      disabled={obsBusy}
                      onClick={() =>
                        void handleObsAction(obsConfigure, "RTMP сервер и ключ записаны в OBS!")
                      }
                    >
                      Прописать RTMP + ключ в OBS
                    </button>

                    <button
                      type="button"
                      className="btn-secondary"
                      disabled={obsBusy}
                      onClick={() =>
                        void handleObsAction(
                          obsMonitorDemo,
                          "Сцена «Демка монитора» создана и запущена в OBS!",
                          true,
                        )
                      }
                    >
                      Демка монитора в OBS
                    </button>

                    {!obs.streaming ? (
                      <button
                        type="button"
                        className="btn-primary"
                        disabled={obsBusy}
                        onClick={() =>
                          void handleObsAction(obsStartStream, "Трансляция в OBS запущена!", true)
                        }
                      >
                        Старт стрима в OBS
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="btn-danger"
                        disabled={obsBusy}
                        onClick={() =>
                          void handleObsAction(obsStopStream, "Трансляция в OBS остановлена")
                        }
                      >
                        Стоп стрима в OBS
                      </button>
                    )}
                  </div>

                  {obs.scenes.length > 0 && (
                    <div className="obs-scenes">
                      <span>Сцены OBS:</span>
                      {obs.scenes.map((scene) => (
                        <button
                          key={scene}
                          type="button"
                          className={scene === obs.current_scene ? "btn-primary" : "btn-secondary"}
                          disabled={obsBusy}
                          onClick={() =>
                            void handleObsAction(
                              () => obsSwitchScene(scene),
                              `Сцена переключена: ${scene}`,
                            )
                          }
                        >
                          {scene}
                        </button>
                      ))}
                    </div>
                  )}
                </>
              )}
            </div>
          )}

          {obsError && <p className="status-err">{obsError}</p>}
          {obsMsg && !obsError && <p className="status-ok">{obsMsg}</p>}
        </div>
      </div>
    </section>
  );
}
