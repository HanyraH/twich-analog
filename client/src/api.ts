import axios, { AxiosError } from "axios";
import { API_BASE_URL } from "./lib/config";

export const api = axios.create({
  baseURL: API_BASE_URL,
});

api.interceptors.request.use((config) => {
  const token = localStorage.getItem("token");
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

api.interceptors.response.use(
  (res) => res,
  (error: AxiosError<{ detail: unknown }>) => {
    if (!error.response) {
      return Promise.reject(new Error("Бэкенд (FastAPI) недоступен на :8000"));
    }
    const detail = error.response.data?.detail;
    let message = `Ошибка ${error.response.status}`;
    if (typeof detail === "string") message = detail;
    else if (Array.isArray(detail)) {
      message = detail.map((e: { msg?: string }) => e.msg || "").filter(Boolean).join("; ");
    }
    return Promise.reject(new Error(message));
  },
);

export type User = { id: number; email: string };
export type Token = { access_token: string; token_type: string };

export type MyStream = {
  stream_key: string;
  path: string;
  title: string;
  mode: "screen" | "obs";
  rtmp_server: string;
  whip_url: string;
  whep_url: string;
  hls_url: string;
};

export type PublicStream = {
  path: string;
  stream_key: string;
  title: string;
  owner_email: string | null;
  mode: string;
  ready: boolean;
  ready_time: string | null;
  tracks: string[];
  readers_count: number;
  bytes_received: number;
  whep_url: string;
  hls_url: string;
};

export type StreamsList = {
  mediamtx_online: boolean;
  streams: PublicStream[];
};

export type OBSStatus = {
  connected: boolean;
  host: string;
  port: number;
  obs_version?: string | null;
  websocket_version?: string | null;
  scenes: string[];
  current_scene: string | null;
  streaming: boolean;
  stream_timecode?: string | null;
  recording: boolean;
  error?: string | null;
};

export const register = (email: string, password: string) =>
  api.post<User>("/register", { email, password }).then((r) => r.data);

export const login = (email: string, password: string) =>
  api
    .post<Token>("/login", new URLSearchParams({ username: email, password }))
    .then((r) => r.data);

export const me = () => api.get<User>("/me").then((r) => r.data);

export const getMyStream = () =>
  api.get<MyStream>("/streams/me").then((r) => r.data);

export const updateMyStream = (payload: { title?: string; mode?: "screen" | "obs" }) =>
  api.patch<MyStream>("/streams/me", payload).then((r) => r.data);

export const rotateMyStreamKey = () =>
  api.post<MyStream>("/streams/me/rotate-key").then((r) => r.data);

export const listStreams = () =>
  api.get<StreamsList>("/streams").then((r) => r.data);

export const obsConnect = (payload: { host: string; port: number; password: string }) =>
  api.post<OBSStatus>("/obs/connect", payload).then((r) => r.data);

export const obsStatus = () =>
  api.get<OBSStatus>("/obs/status").then((r) => r.data);

export const obsConfigure = () =>
  api.post<OBSStatus>("/obs/configure").then((r) => r.data);

export const obsStartStream = () =>
  api.post<OBSStatus>("/obs/stream/start").then((r) => r.data);

export const obsStopStream = () =>
  api.post<OBSStatus>("/obs/stream/stop").then((r) => r.data);

export const obsSwitchScene = (scene_name: string) =>
  api.post<OBSStatus>("/obs/scene", { scene_name }).then((r) => r.data);

export const obsMonitorDemo = () =>
  api.post<OBSStatus>("/obs/monitor-demo").then((r) => r.data);
