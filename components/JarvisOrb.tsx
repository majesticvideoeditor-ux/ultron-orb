"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createOrbScene, type OrbSceneApi } from "@/lib/orbScene";
import { HandTracker, type TrackerStatus } from "@/lib/handTracker";

type CameraState = "off" | "starting" | "on" | "error";

interface LogEntry {
  speaker?: string;
  text?: string;
  type?: string;
  ts?: string;
}

const MODE_LABEL: Record<TrackerStatus["mode"], string> = {
  idle: "STANDBY",
  spin: "SPIN",
  zoom: "ZOOM",
};

export default function JarvisOrb() {
  const containerRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const sceneRef = useRef<OrbSceneApi | null>(null);
  const trackerRef = useRef<HandTracker | null>(null);

  const [camera, setCamera] = useState<CameraState>("off");
  const [status, setStatus] = useState<TrackerStatus>({ hands: 0, mode: "idle" });
  const [error, setError] = useState<string | null>(null);

  // Jarvis Live Remote State
  const [jarvisConnected, setJarvisConnected] = useState(false);
  const [jarvisState, setJarvisState] = useState<string>("CONNECTING");
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [inputText, setInputText] = useState("");
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const scene = createOrbScene(container);
    sceneRef.current = scene;
    return () => {
      trackerRef.current?.stop();
      trackerRef.current = null;
      scene.dispose();
      sceneRef.current = null;
    };
  }, []);

  // Connect to Jarvis backend on port 8000
  useEffect(() => {
    let ws: WebSocket | null = null;
    let timer: NodeJS.Timeout;

    const connectToJarvis = () => {
      const host = "localhost";
      const wsUrl = `ws://${host}:8000/ws/live`;
      const httpUrl = `http://${host}:8000/api/status`;

      // Initial HTTP health check
      fetch(httpUrl)
        .then((res) => res.json())
        .then((data) => {
          setJarvisConnected(true);
          setJarvisState(data.state || "ONLINE");
        })
        .catch(() => {
          setJarvisConnected(false);
          setJarvisState("OFFLINE");
        });

      try {
        ws = new WebSocket(wsUrl);
        wsRef.current = ws;

        ws.onopen = () => {
          setJarvisConnected(true);
        };

        ws.onmessage = (event) => {
          try {
            const data = JSON.parse(event.data);
            if (data.type === "status") {
              setJarvisState(data.state || "ACTIVE");
            } else if (data.type === "log" || data.speaker) {
              setLogs((prev) => [...prev.slice(-25), data]);
            }
          } catch {
            // ignore non-json
          }
        };

        ws.onclose = () => {
          setJarvisConnected(false);
          setJarvisState("OFFLINE");
          timer = setTimeout(connectToJarvis, 4000);
        };

        ws.onerror = () => {
          ws?.close();
        };
      } catch {
        setJarvisConnected(false);
        setJarvisState("OFFLINE");
        timer = setTimeout(connectToJarvis, 4000);
      }
    };

    connectToJarvis();

    return () => {
      if (ws) ws.close();
      clearTimeout(timer);
    };
  }, []);

  const sendAction = async (action: string) => {
    // 1. Direct console bridge for QtWebEngine inside Jarvis HUD
    console.log(`JARVIS_ACTION:${action}`);

    // 2. Local network fallback
    const host = "localhost";
    try {
      if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({ type: "action", action }));
      } else {
        await fetch(`http://${host}:8000/api/action`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action }),
          signal: AbortSignal.timeout(500),
        });
      }
    } catch {
      // quiet on standalone web
    }
  };

  const sendCommand = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (!inputText.trim()) return;
    const cmd = inputText.trim();
    setInputText("");

    console.log(`JARVIS_COMMAND:${cmd}`);

    const host = "localhost";
    try {
      if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({ type: "command", text: cmd }));
      } else {
        await fetch(`http://${host}:8000/api/command`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: cmd }),
          signal: AbortSignal.timeout(500),
        });
      }
    } catch {
      // quiet on standalone web
    }
    setLogs((prev) => [...prev.slice(-25), { speaker: "user", text: cmd }]);
  };

  const stopGestures = useCallback(() => {
    trackerRef.current?.stop();
    trackerRef.current = null;
    void sendAction("resume_camera");
    setCamera("off");
    setStatus({ hands: 0, mode: "idle" });
  }, []);

  const startGestures = useCallback(async () => {
    const video = videoRef.current;
    const overlay = overlayRef.current;
    if (!video || !overlay || trackerRef.current) return;

    setCamera("starting");
    setError(null);

    // Release Python camera so Windows webcam isn't locked
    await sendAction("pause_camera");
    await new Promise((r) => setTimeout(r, 200));

    const tracker = new HandTracker(video, overlay, {
      onRotate: (dt, dp) => sceneRef.current?.rotateBy(dt, dp),
      onZoom: (factor) => sceneRef.current?.zoomBy(factor),
      onStatus: setStatus,
      onPalm: () => {
        sendAction("interrupt");
        setLogs((prev) => [...prev.slice(-25), { speaker: "gesture", text: "🖐 Open Palm detected -> Silenced" }]);
      },
    });
    trackerRef.current = tracker;

    try {
      await tracker.start();
      setCamera("on");
    } catch (err) {
      console.error("Tracker start failed:", err);
      trackerRef.current = null;
      tracker.stop();
      void sendAction("resume_camera");
      setCamera("error");
      const errName = (err && typeof err === "object" && "name" in err) ? (err as { name: string }).name : "";
      if (errName === "NotAllowedError" || (err instanceof DOMException && err.name === "NotAllowedError")) {
        setError("CAMERA ACCESS DENIED");
      } else if (errName === "NotReadableError" || (err instanceof DOMException && err.name === "NotReadableError")) {
        setError("WEBCAM IN USE BY ANOTHER APP");
      } else {
        const msg = err instanceof Error ? err.message : String(err);
        setError(msg ? `TRACKING INIT FAILED: ${msg}` : "TRACKING INIT FAILED");
      }
    }
  }, []);

  const toggleGestures = useCallback(() => {
    if (trackerRef.current) stopGestures();
    else void startGestures();
  }, [startGestures, stopGestures]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Don't intercept if user is typing in the input box
      if (document.activeElement?.tagName === "INPUT") return;

      switch (e.key) {
        case "+":
        case "=":
          sceneRef.current?.zoomIn();
          break;
        case "-":
        case "_":
          sceneRef.current?.zoomOut();
          break;
        case "r":
        case "R":
          sceneRef.current?.resetView();
          break;
        case "g":
        case "G":
          toggleGestures();
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggleGestures]);

  const cameraOn = camera === "on";

  return (
    <>
      <div ref={containerRef} className="orb-root" />

      <div className="overlay-vignette" />
      <div className="overlay-grain" />
      <div className="overlay-scanlines" />

      {/* Jarvis Live Mobile Dashboard Card */}
      <div className="jarvis-hud-left">
        <div className="jarvis-status-card">
          <div className="jarvis-status-text">
            <span
              className={`status-dot ${
                !jarvisConnected ? "offline" : jarvisState === "SLEEPING" ? "sleeping" : ""
              }`}
            />
            JARVIS // {jarvisState}
          </div>
          <div style={{ fontSize: "11px", opacity: 0.7 }}>
            {jarvisConnected ? "LOCAL NETWORK" : "DISCONNECTED"}
          </div>
        </div>

        {/* Remote Action Touch Buttons */}
        <div className="jarvis-actions">
          <button type="button" className="jarvis-act-btn" onClick={() => sendAction("wake")}>
            ⚡ WAKE
          </button>
          <button type="button" className="jarvis-act-btn" onClick={() => sendAction("interrupt")}>
            🛑 SILENCE
          </button>
          <button type="button" className="jarvis-act-btn" onClick={() => sendAction("sleep")}>
            💤 SLEEP
          </button>
        </div>

        {/* Live Conversation Transcript */}
        {logs.length > 0 && (
          <div className="jarvis-log-box">
            {logs.map((log, idx) => (
              <div key={idx} className={`jarvis-log-entry ${log.speaker || "sys"}`}>
                <strong style={{ textTransform: "uppercase" }}>{log.speaker || "SYS"}:</strong> {log.text}
              </div>
            ))}
          </div>
        )}

        {/* Wireless Command Bar */}
        <form onSubmit={sendCommand} className="jarvis-input-row">
          <input
            type="text"
            className="jarvis-input"
            placeholder="Type command to PC..."
            value={inputText}
            onChange={(e) => setInputText(e.target.value)}
          />
          <button type="submit" className="jarvis-send-btn">
            SEND
          </button>
        </form>
      </div>

      <div className="hud hud-title">U.L.T.R.O.N. // ORB</div>

      <div className="hud hud-hint">
        <div>
          <span className="key">DRAG</span> spin&nbsp;&nbsp;
          <span className="key">SCROLL</span> zoom
        </div>
        {cameraOn ? (
          <div>
            <div><span className="key">✋ PALM</span> Silence / Interrupt</div>
            <div><span className="key">🤏 PINCH</span> Spin &nbsp;|&nbsp; <span className="key">2-HANDS</span> Zoom</div>
          </div>
        ) : (
          <div>
            <div><span className="key">G</span> Enable Hand Tracking (Palm = Silence)</div>
            <div><span className="key">DRAG</span> Spin &nbsp;|&nbsp; <span className="key">SCROLL</span> Zoom</div>
          </div>
        )}
      </div>

      <div className="hud hud-controls">
        <div className={`camera-panel${cameraOn ? " visible" : ""}`}>
          <video ref={videoRef} muted playsInline className="camera-video" />
          <canvas ref={overlayRef} width={208} height={156} className="camera-overlay" />
          <div className="camera-status">
            {status.hands > 0
              ? `${status.hands} HAND${status.hands > 1 ? "S" : ""} · ${MODE_LABEL[status.mode]}`
              : "SHOW HANDS"}
          </div>
        </div>

        {error && <div className="hud-error">{error}</div>}

        <div className="hud-row">
          <button
            type="button"
            className="hud-btn"
            aria-pressed={cameraOn}
            onClick={toggleGestures}
            disabled={camera === "starting"}
          >
            {camera === "starting" ? "INITIALIZING…" : cameraOn ? "GESTURES ON" : "GESTURES OFF"}
          </button>
        </div>
        <div className="hud-row">
          <button type="button" className="hud-btn" onClick={() => sceneRef.current?.zoomIn()} aria-label="Zoom in">
            +
          </button>
          <button type="button" className="hud-btn" onClick={() => sceneRef.current?.zoomOut()} aria-label="Zoom out">
            −
          </button>
          <button type="button" className="hud-btn" onClick={() => sceneRef.current?.resetView()}>
            RESET
          </button>
        </div>
      </div>
    </>
  );
}
