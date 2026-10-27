import { Button } from "@stackd/ui";
import { useEffect, useRef, useState } from "react";
import { codeFromScan } from "../auth/linkCode.ts";

interface Detector {
  detect: (source: CanvasImageSource) => Promise<Array<{ rawValue: string }>>;
}
declare global {
  interface Window {
    BarcodeDetector?: new (opts: { formats: string[] }) => Detector;
  }
}

/** The browser can open a camera here (an installed iPhone app can, from iOS 13.4). */
export function canScan(): boolean {
  return typeof navigator !== "undefined" && Boolean(navigator.mediaDevices?.getUserMedia);
}

/**
 * Scans the computer's Qash QR code inside the app (B3, October 19, 2026). Inside the app because
 * the phone's own Camera app opens the code in Safari, which on iPhone is not where the person is
 * signed in. Frames are read on the device (the browser's BarcodeDetector where there is one,
 * else jsQR, loaded only now) and nothing is kept or sent; the camera stops on leaving.
 */
export function QrScanner({
  onCode,
  onCancel,
}: {
  onCode: (code: string) => void;
  onCancel: () => void;
}) {
  const video = useRef<HTMLVideoElement>(null);
  const [problem, setProblem] = useState<"denied" | "unavailable" | "other_code" | null>(null);
  const found = useRef(onCode);
  found.current = onCode;

  useEffect(() => {
    let stream: MediaStream | null = null;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const canvas = document.createElement("canvas");
    void (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: "environment" } },
          audio: false,
        });
      } catch (err) {
        if (!stopped)
          setProblem((err as DOMException)?.name === "NotAllowedError" ? "denied" : "unavailable");
        return;
      }
      if (stopped || !video.current) return;
      video.current.srcObject = stream;
      await video.current.play().catch(() => undefined);
      const native = window.BarcodeDetector
        ? new window.BarcodeDetector({ formats: ["qr_code"] })
        : null;
      const fallback = native ? null : (await import("jsqr")).default;
      const read = async (): Promise<string | null> => {
        const v = video.current;
        if (!v || v.readyState < 2 || !v.videoWidth) return null;
        if (native) return (await native.detect(v))[0]?.rawValue ?? null;
        canvas.width = v.videoWidth;
        canvas.height = v.videoHeight;
        const ctx = canvas.getContext("2d", { willReadFrequently: true });
        if (!ctx || !fallback) return null;
        ctx.drawImage(v, 0, 0);
        const frame = ctx.getImageData(0, 0, canvas.width, canvas.height);
        return (
          fallback(frame.data, frame.width, frame.height, { inversionAttempts: "dontInvert" })
            ?.data ?? null
        );
      };
      const tick = async () => {
        if (stopped) return;
        const text = await read().catch(() => null);
        if (text) {
          const code = codeFromScan(text);
          if (code) return found.current(code);
          setProblem("other_code");
        }
        timer = setTimeout(tick, 250);
      };
      void tick();
    })();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      for (const track of stream?.getTracks() ?? []) track.stop();
    };
  }, []);

  if (problem === "denied" || problem === "unavailable")
    return (
      <div className="scan__problem sk-card" role="alert">
        <strong>{problem === "denied" ? "Camera is off for Qash" : "No camera here"}</strong>
        <span>
          {problem === "denied"
            ? "Allow the camera in your phone's settings, or type the code instead."
            : "Type the code from the computer instead."}
        </span>
        <Button variant="secondary" block onClick={onCancel}>
          Type the code
        </Button>
      </div>
    );
  return (
    <div className="scan">
      <div className="scan__frame">
        <video ref={video} className="scan__video" playsInline muted aria-label="Camera" />
        <span className="scan__target" aria-hidden="true" />
      </div>
      <p className="scan__hint" role="status">
        {problem === "other_code"
          ? "That's not a Qash code. Point at the code on the computer."
          : "Point your camera at the code on the computer"}
      </p>
      <Button variant="secondary" block onClick={onCancel}>
        Type the code instead
      </Button>
    </div>
  );
}
