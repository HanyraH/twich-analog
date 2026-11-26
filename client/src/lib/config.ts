export const API_BASE_URL =
  import.meta.env.VITE_API_URL || "http://127.0.0.1:8000";

export const CHAT_WS_URL =
  import.meta.env.VITE_CHAT_WS_URL || "ws://127.0.0.1:8081/ws";

export const MEDIAMTX_HOST =
  import.meta.env.VITE_MEDIAMTX_HOST || "127.0.0.1";

export const MEDIAMTX_WEBRTC_PORT =
  import.meta.env.VITE_MEDIAMTX_WEBRTC_PORT || "8889";

export const MEDIAMTX_HLS_PORT =
  import.meta.env.VITE_MEDIAMTX_HLS_PORT || "8888";

export function normalizeStreamPath(path: string): string {
  const clean = path.trim().replace(/^\/+|\/+$/g, "");
  return clean || "live/stream";
}

export function whepUrl(path: string): string {
  return `http://${MEDIAMTX_HOST}:${MEDIAMTX_WEBRTC_PORT}/${normalizeStreamPath(path)}/whep`;
}

export function whipUrl(path: string): string {
  return `http://${MEDIAMTX_HOST}:${MEDIAMTX_WEBRTC_PORT}/${normalizeStreamPath(path)}/whip`;
}

export function hlsUrl(path: string): string {
  return `http://${MEDIAMTX_HOST}:${MEDIAMTX_HLS_PORT}/${normalizeStreamPath(path)}/index.m3u8`;
}
