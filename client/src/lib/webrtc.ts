export interface WhepSession {
  pc: RTCPeerConnection;
  close: () => Promise<void>;
}

export interface WhipPublishSession {
  pc: RTCPeerConnection;
  stream: MediaStream;
  stop: () => Promise<void>;
}

function resolveLocationUrl(locationHeader: string | null, endpointUrl: string): string | null {
  if (!locationHeader) return null;
  try {
    return new URL(locationHeader, endpointUrl).toString();
  } catch {
    return null;
  }
}

async function deleteSession(sessionUrl: string | null): Promise<void> {
  if (!sessionUrl) return;
  try {
    await fetch(sessionUrl, { method: "DELETE" });
  } catch {
    // Ignore network errors during teardown
  }
}

/**
 * Connects to a MediaMTX WHEP endpoint and invokes onTrack with the remote MediaStream.
 */
export async function startWhepPlayer(
  endpointUrl: string,
  onStream: (stream: MediaStream) => void,
  onStateChange?: (state: RTCPeerConnectionState) => void,
): Promise<WhepSession> {
  const pc = new RTCPeerConnection({ iceServers: [] });
  let sessionUrl: string | null = null;
  let closed = false;

  const remoteStream = new MediaStream();
  pc.ontrack = (event) => {
    if (event.streams && event.streams[0]) {
      onStream(event.streams[0]);
      return;
    }
    remoteStream.addTrack(event.track);
    onStream(remoteStream);
  };

  pc.onconnectionstatechange = () => {
    onStateChange?.(pc.connectionState);
  };

  pc.addTransceiver("video", { direction: "recvonly" });
  pc.addTransceiver("audio", { direction: "recvonly" });

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);

  const res = await fetch(endpointUrl, {
    method: "POST",
    headers: { "Content-Type": "application/sdp" },
    body: offer.sdp,
  });

  if (!res.ok) {
    pc.close();
    throw new Error(`WHEP HTTP ${res.status}`);
  }

  sessionUrl = resolveLocationUrl(res.headers.get("Location"), endpointUrl);
  const answerSdp = await res.text();
  if (closed) {
    pc.close();
    await deleteSession(sessionUrl);
    throw new Error("WHEP session aborted");
  }

  await pc.setRemoteDescription({ type: "answer", sdp: answerSdp });

  return {
    pc,
    close: async () => {
      if (closed) return;
      closed = true;
      pc.close();
      await deleteSession(sessionUrl);
    },
  };
}

/**
 * Captures the user's screen (and optionally microphone) and publishes it to MediaMTX via WHIP.
 */
export async function startScreenShareWhip(
  endpointUrl: string,
  options: {
    includeMic?: boolean;
    onEnded?: () => void;
    onStateChange?: (state: RTCPeerConnectionState) => void;
  } = {},
): Promise<WhipPublishSession> {
  if (!navigator.mediaDevices?.getDisplayMedia) {
    throw new Error("Браузер не поддерживает захват экрана (getDisplayMedia)");
  }

  const displayStream = await navigator.mediaDevices.getDisplayMedia({
    video: {
      frameRate: { ideal: 30, max: 60 },
    },
    audio: true,
  });

  let micStream: MediaStream | null = null;
  const combinedStream = new MediaStream();

  const videoTrack = displayStream.getVideoTracks()[0];
  if (!videoTrack) {
    displayStream.getTracks().forEach((t) => t.stop());
    throw new Error("Видеодорожка экрана не получена");
  }
  combinedStream.addTrack(videoTrack);

  const displayAudioTrack = displayStream.getAudioTracks()[0];
  if (options.includeMic && navigator.mediaDevices?.getUserMedia) {
    try {
      micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      // If mic permission is denied, continue with screen capture only
      micStream = null;
    }
  }

  let audioContext: AudioContext | null = null;
  if (displayAudioTrack && micStream?.getAudioTracks()[0]) {
    audioContext = new AudioContext();
    const dest = audioContext.createMediaStreamDestination();
    const src1 = audioContext.createMediaStreamSource(new MediaStream([displayAudioTrack]));
    const src2 = audioContext.createMediaStreamSource(new MediaStream([micStream.getAudioTracks()[0]]));
    src1.connect(dest);
    src2.connect(dest);
    const mixed = dest.stream.getAudioTracks()[0];
    if (mixed) combinedStream.addTrack(mixed);
  } else if (displayAudioTrack) {
    combinedStream.addTrack(displayAudioTrack);
  } else if (micStream?.getAudioTracks()[0]) {
    combinedStream.addTrack(micStream.getAudioTracks()[0]);
  }

  const pc = new RTCPeerConnection({ iceServers: [] });
  let sessionUrl: string | null = null;
  let stopped = false;

  pc.onconnectionstatechange = () => {
    options.onStateChange?.(pc.connectionState);
  };

  const videoTransceiver = pc.addTransceiver(videoTrack, {
    direction: "sendonly",
    streams: [combinedStream],
  });

  // Prefer H264 when available so HLS viewers can also decode the stream.
  if (typeof RTCRtpSender !== "undefined" && typeof RTCRtpSender.getCapabilities === "function") {
    const caps = RTCRtpSender.getCapabilities("video");
    if (caps?.codecs && typeof videoTransceiver.setCodecPreferences === "function") {
      const h264 = caps.codecs.filter((c) => c.mimeType.toLowerCase() === "video/h264");
      const rest = caps.codecs.filter((c) => c.mimeType.toLowerCase() !== "video/h264");
      if (h264.length > 0) {
        try {
          videoTransceiver.setCodecPreferences([...h264, ...rest]);
        } catch {
          // Ignore if browser rejects custom codec ordering
        }
      }
    }
  }

  const audioTrack = combinedStream.getAudioTracks()[0];
  if (audioTrack) {
    pc.addTransceiver(audioTrack, {
      direction: "sendonly",
      streams: [combinedStream],
    });
  }

  const stop = async () => {
    if (stopped) return;
    stopped = true;
    pc.close();
    displayStream.getTracks().forEach((t) => t.stop());
    micStream?.getTracks().forEach((t) => t.stop());
    combinedStream.getTracks().forEach((t) => t.stop());
    if (audioContext) {
      await audioContext.close().catch(() => {});
    }
    await deleteSession(sessionUrl);
  };

  videoTrack.onended = () => {
    void stop().finally(() => options.onEnded?.());
  };

  try {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    const res = await fetch(endpointUrl, {
      method: "POST",
      headers: { "Content-Type": "application/sdp" },
      body: offer.sdp,
    });

    if (!res.ok) {
      throw new Error(`WHIP HTTP ${res.status}: проверьте, что MediaMTX запущен`);
    }

    sessionUrl = resolveLocationUrl(res.headers.get("Location"), endpointUrl);
    const answerSdp = await res.text();
    await pc.setRemoteDescription({ type: "answer", sdp: answerSdp });
  } catch (err) {
    await stop();
    throw err;
  }

  return { pc, stream: combinedStream, stop };
}
