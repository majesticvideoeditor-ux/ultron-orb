import {
  FilesetResolver,
  HandLandmarker,
  type NormalizedLandmark,
} from "@mediapipe/tasks-vision";

function getAssetPrefix(): string {
  if (typeof window !== "undefined" && window.location.pathname.startsWith("/ultron-orb")) {
    return "/ultron-orb";
  }
  return "";
}

const WASM_LOCAL = `${getAssetPrefix()}/wasm`;
const WASM_CDN =
  "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.35/wasm";
const MODEL_LOCAL = `${getAssetPrefix()}/models/hand_landmarker.task`;
const MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task";

// Landmark indices (MediaPipe hand model)
const WRIST = 0;
const THUMB_TIP = 4;
const INDEX_MCP = 5;
const INDEX_TIP = 8;
const MIDDLE_MCP = 9;
const PINKY_MCP = 17;
const PINKY_TIP = 20;

// Pinch hysteresis: thumb–index distance relative to hand size
const PINCH_ON = 0.32;
const PINCH_OFF = 0.45;

// How strongly hand movement rotates the orb (radians per normalized unit)
const ROTATE_SPEED = 7.5;
// Smoothing factor for grab-point tracking (0..1, higher = snappier, lower = smoother)
const SMOOTHING = 0.55;

export type GestureMode = "idle" | "spin" | "zoom";

export interface TrackerStatus {
  hands: number;
  mode: GestureMode;
}

export interface HandTrackerCallbacks {
  /** Called when a single pinched hand drags: deltas in mirrored normalized coords. */
  onRotate(deltaTheta: number, deltaPhi: number): void;
  /** Called when both hands pinch and spread/close: multiply camera distance by factor. */
  onZoom(factor: number): void;
  onStatus(status: TrackerStatus): void;
  /** Open palm held towards camera -> Silence / Interrupt */
  onPalm?(): void;
}

interface Point {
  x: number;
  y: number;
}

interface HandState {
  pinching: boolean;
  grab: Point; // smoothed pinch midpoint, mirrored
}

export class HandTracker {
  private video: HTMLVideoElement;
  private overlay: HTMLCanvasElement;
  private callbacks: HandTrackerCallbacks;
  private landmarker: HandLandmarker | null = null;
  private stream: MediaStream | null = null;
  private rafId = 0;
  private running = false;
  private lastVideoTime = -1;

  // keyed by handedness label so state survives re-ordering between frames
  private handStates = new Map<string, HandState>();
  private prevMode: GestureMode = "idle";
  private prevSpinGrab: Point | null = null;
  private prevZoomDist: number | null = null;
  private lastStatus: TrackerStatus = { hands: 0, mode: "idle" };
  private lastActionGestureTime = 0;
  private actionGestureHold = 0;

  constructor(
    video: HTMLVideoElement,
    overlay: HTMLCanvasElement,
    callbacks: HandTrackerCallbacks,
  ) {
    this.video = video;
    this.overlay = overlay;
    this.callbacks = callbacks;
  }

  async start(): Promise<void> {
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        video: { width: 640, height: 480, facingMode: "user" },
        audio: false,
      });
    } catch {
      this.stream = await navigator.mediaDevices.getUserMedia({
        video: true,
        audio: false,
      });
    }
    this.video.srcObject = this.stream;
    await this.video.play().catch(() => {});

    let fileset;
    try {
      fileset = await FilesetResolver.forVisionTasks(WASM_LOCAL);
    } catch {
      fileset = await FilesetResolver.forVisionTasks(WASM_CDN);
    }

    const options = {
      baseOptions: { modelAssetPath: MODEL_LOCAL, delegate: "GPU" as const },
      runningMode: "VIDEO" as const,
      numHands: 2,
      minHandDetectionConfidence: 0.5,
      minHandPresenceConfidence: 0.5,
      minTrackingConfidence: 0.5,
    };
    try {
      this.landmarker = await HandLandmarker.createFromOptions(fileset, options);
    } catch {
      try {
        this.landmarker = await HandLandmarker.createFromOptions(fileset, {
          ...options,
          baseOptions: { ...options.baseOptions, delegate: "CPU" as const },
        });
      } catch {
        this.landmarker = await HandLandmarker.createFromOptions(fileset, {
          ...options,
          baseOptions: { modelAssetPath: MODEL_URL, delegate: "CPU" as const },
        });
      }
    }

    this.running = true;
    this.loop();
  }

  stop(): void {
    this.running = false;
    cancelAnimationFrame(this.rafId);
    this.landmarker?.close();
    this.landmarker = null;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.video.srcObject = null;
    this.handStates.clear();
    this.prevMode = "idle";
    this.prevSpinGrab = null;
    this.prevZoomDist = null;
    const ctx = this.overlay.getContext("2d");
    ctx?.clearRect(0, 0, this.overlay.width, this.overlay.height);
    this.emitStatus({ hands: 0, mode: "idle" });
  }

  private loop = () => {
    if (!this.running) return;
    this.rafId = requestAnimationFrame(this.loop);

    if (!this.landmarker || this.video.readyState < 2) return;
    if (this.video.currentTime === this.lastVideoTime) return;
    this.lastVideoTime = this.video.currentTime;

    const result = this.landmarker.detectForVideo(this.video, performance.now());
    this.processHands(result.landmarks, result.handedness.map((h) => h[0]?.categoryName ?? "?"));
    this.drawOverlay(result.landmarks);
  };

  private processHands(
    landmarks: NormalizedLandmark[][],
    labels: string[],
  ): void {
    const pinchedGrabs: Point[] = [];
    const seen = new Set<string>();

    landmarks.forEach((lm, i) => {
      const label = labels[i];
      seen.add(label);

      const handScale = dist2d(lm[WRIST], lm[MIDDLE_MCP]);
      if (handScale < 1e-6) return;
      const pinchRatio = dist2d(lm[THUMB_TIP], lm[INDEX_TIP]) / handScale;

      // Mirrored so hand-right = screen-right from the user's perspective
      const raw: Point = {
        x: 1 - (lm[THUMB_TIP].x + lm[INDEX_TIP].x) / 2,
        y: (lm[THUMB_TIP].y + lm[INDEX_TIP].y) / 2,
      };

      let state = this.handStates.get(label);
      if (!state) {
        state = { pinching: false, grab: raw };
        this.handStates.set(label, state);
      }

      // Hysteresis so the pinch doesn't flicker on/off at the threshold
      if (state.pinching && pinchRatio > PINCH_OFF) state.pinching = false;
      else if (!state.pinching && pinchRatio < PINCH_ON) state.pinching = true;

      state.grab = {
        x: state.grab.x + (raw.x - state.grab.x) * SMOOTHING,
        y: state.grab.y + (raw.y - state.grab.y) * SMOOTHING,
      };

      if (state.pinching) pinchedGrabs.push(state.grab);
    });

    // Drop state for hands that left the frame
    for (const key of this.handStates.keys()) {
      if (!seen.has(key)) this.handStates.delete(key);
    }

    const mode: GestureMode =
      pinchedGrabs.length >= 2 ? "zoom" : pinchedGrabs.length === 1 ? "spin" : "idle";

    // Reset reference points on any mode change to avoid jumps
    if (mode !== this.prevMode) {
      this.prevSpinGrab = null;
      this.prevZoomDist = null;
      this.prevMode = mode;
    }

    if (mode === "spin") {
      const grab = pinchedGrabs[0];
      if (this.prevSpinGrab) {
        const dx = grab.x - this.prevSpinGrab.x;
        const dy = grab.y - this.prevSpinGrab.y;
        if (Math.abs(dx) > 1e-4 || Math.abs(dy) > 1e-4) {
          this.callbacks.onRotate(dx * ROTATE_SPEED, dy * ROTATE_SPEED);
        }
      }
      this.prevSpinGrab = grab;
    } else if (mode === "zoom") {
      const d = Math.hypot(
        pinchedGrabs[0].x - pinchedGrabs[1].x,
        pinchedGrabs[0].y - pinchedGrabs[1].y,
      );
      if (this.prevZoomDist && d > 1e-4) {
        // Spread hands apart -> factor < 1 -> camera moves closer
        const factor = Math.min(1.18, Math.max(0.85, this.prevZoomDist / d));
        this.callbacks.onZoom(factor);
      }
      this.prevZoomDist = d;
    }

    // Purposeful Full Open Palm (Silence / Interrupt) — strictly ignores back of hand and pre-pinch posture
    const now = performance.now();
    if (landmarks.length === 1 && mode === "idle" && pinchedGrabs.length === 0 && (now - this.lastActionGestureTime > 1200)) {
      const lm = landmarks[0];
      const label = labels[0] || "Right";
      const handScale = dist2d(lm[WRIST], lm[MIDDLE_MCP]);

      if (handScale > 0.04) {
        // 1. PALM MUST BE FACING WEBCAM (strictly reject back of hand)
        // In mirrored space: x is mirrored
        const mx0 = 1 - lm[WRIST].x;
        const mx9 = 1 - lm[MIDDLE_MCP].x;
        const mx5 = 1 - lm[INDEX_MCP].x;
        const mx17 = 1 - lm[PINKY_MCP].x;
        const ux = mx9 - mx0;
        const uy = lm[MIDDLE_MCP].y - lm[WRIST].y;
        const vx = mx5 - mx17;
        const vy = lm[INDEX_MCP].y - lm[PINKY_MCP].y;
        const cross = ux * vy - uy * vx;
        const isPalmFacing = label === "Right" ? cross > 0.012 : cross < -0.012;

        if (isPalmFacing) {
          // 2. ALL 4 FINGERS MUST BE FULLY EXTENDED
          let extended = 0;
          for (const [tip, mcp] of [[8, 5], [12, 9], [16, 13], [20, 17]]) {
            if (dist2d(lm[tip], lm[WRIST]) > dist2d(lm[mcp], lm[WRIST]) * 1.20) {
              extended++;
            }
          }

          // 3. THUMB SPLAYED WIDE & NOT CONVERGING TO PINCH
          const thumbIndexDist = dist2d(lm[THUMB_TIP], lm[INDEX_TIP]) / handScale;
          const handSpread = dist2d(lm[INDEX_TIP], lm[PINKY_TIP]) / handScale;

          // When preparing to pinch, thumb and index distance is < 0.55
          // Purposeful full open palm has thumb spread wide (> 0.62) and full 4 fingers splayed (> 0.50)
          if (extended === 4 && thumbIndexDist > 0.62 && handSpread > 0.50) {
            this.actionGestureHold++;
            if (this.actionGestureHold >= 5) {
              this.callbacks.onPalm?.();
              this.lastActionGestureTime = now;
              this.actionGestureHold = 0;
            }
          } else {
            this.actionGestureHold = 0;
          }
        } else {
          this.actionGestureHold = 0;
        }
      }
    } else {
      this.actionGestureHold = 0;
    }

    this.emitStatus({ hands: landmarks.length, mode });
  }

  private emitStatus(status: TrackerStatus): void {
    if (
      status.hands !== this.lastStatus.hands ||
      status.mode !== this.lastStatus.mode
    ) {
      this.lastStatus = status;
      this.callbacks.onStatus(status);
    }
  }

  private drawOverlay(landmarks: NormalizedLandmark[][]): void {
    const ctx = this.overlay.getContext("2d");
    if (!ctx) return;
    const { width, height } = this.overlay;
    ctx.clearRect(0, 0, width, height);

    for (const lm of landmarks) {
      const thumb = lm[THUMB_TIP];
      const index = lm[INDEX_TIP];
      // Overlay canvas sits on the mirrored video preview, so mirror x here too
      const tx = (1 - thumb.x) * width;
      const ty = thumb.y * height;
      const ix = (1 - index.x) * width;
      const iy = index.y * height;

      const handScale = dist2d(lm[WRIST], lm[MIDDLE_MCP]);
      const pinched =
        handScale > 1e-6 && dist2d(thumb, index) / handScale < PINCH_ON;

      ctx.strokeStyle = pinched ? "#ffcc66" : "rgba(255,170,48,0.5)";
      ctx.lineWidth = pinched ? 2 : 1;
      ctx.beginPath();
      ctx.moveTo(tx, ty);
      ctx.lineTo(ix, iy);
      ctx.stroke();

      ctx.fillStyle = pinched ? "#ffcc66" : "rgba(255,170,48,0.7)";
      for (const [x, y] of [
        [tx, ty],
        [ix, iy],
      ]) {
        ctx.beginPath();
        ctx.arc(x, y, pinched ? 5 : 3, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }
}

function dist2d(a: NormalizedLandmark, b: NormalizedLandmark): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}
