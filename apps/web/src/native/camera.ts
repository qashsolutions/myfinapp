/**
 * Receipt capture through the native camera (Phase 2, chunk 2.3; spec `camera.ts`). The shell
 * registers the Camera plugin; the PWA keeps its file input, because `nativePlugin` answers
 * null outside a shell. The photo comes back as bytes and goes through the exact same
 * `stripMetadata` path as any upload: it never leaves the device.
 */

import { nativePlugin } from "../lib/platform.ts";

interface CameraPlugin {
  getPhoto(options: {
    resultType: "base64";
    source: "PROMPT";
    quality: number;
    correctOrientation: boolean;
    saveToGallery: boolean;
    promptLabelHeader: string;
  }): Promise<{ base64String?: string; format?: string }>;
}

export function nativeCameraAvailable(): boolean {
  return nativePlugin("Camera") !== null;
}

/** Camera or library, the OS asks; null when cancelled or outside a shell. */
export async function takeReceiptPhoto(): Promise<File | null> {
  const camera = nativePlugin<CameraPlugin>("Camera");
  if (!camera) return null;
  let photo: { base64String?: string; format?: string };
  try {
    photo = await camera.getPhoto({
      resultType: "base64",
      source: "PROMPT",
      quality: 90,
      correctOrientation: true,
      saveToGallery: false,
      promptLabelHeader: "Receipt photo",
    });
  } catch {
    return null; // cancelled
  }
  if (!photo.base64String) return null;
  const binary = atob(photo.base64String);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  const png = (photo.format ?? "").toLowerCase() === "png";
  return new File([bytes.buffer as ArrayBuffer], png ? "receipt.png" : "receipt.jpg", {
    type: png ? "image/png" : "image/jpeg",
  });
}
