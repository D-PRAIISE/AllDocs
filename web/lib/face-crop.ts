/**
 * Face-aware image cropping (lesson #6).
 *
 * Detects the largest face in an overlay image and biases the crop
 * window so the face stays in frame when the overlay's aspect doesn't
 * match the target region. Falls back to the older portrait-top-bias
 * heuristic if model loading or inference fails — never throws past
 * the caller.
 *
 * face-api.js + the tiny face detector run client-side via tensorflow.js;
 * the model is ~190KB and lazy-loaded only on the first image-replace
 * invocation. Subsequent calls reuse the cached model.
 */

type Box = { x: number; y: number; w: number; h: number };

let modelLoaded = false;
let modelLoading: Promise<void> | null = null;

async function ensureModel(): Promise<boolean> {
  if (modelLoaded) return true;
  if (modelLoading) {
    try {
      await modelLoading;
      return modelLoaded;
    } catch {
      return false;
    }
  }
  modelLoading = (async () => {
    const faceapi = await import("face-api.js");
    await faceapi.nets.tinyFaceDetector.loadFromUri("/face-models");
    modelLoaded = true;
  })();
  try {
    await modelLoading;
    return modelLoaded;
  } catch {
    modelLoading = null;
    return false;
  }
}

/** Largest detected face on the image, in image-pixel coordinates.
 * Returns null if no faces were detected or detection failed. */
export async function detectLargestFace(image: HTMLImageElement): Promise<Box | null> {
  if (!(await ensureModel())) return null;
  try {
    const faceapi = await import("face-api.js");
    const detections = await faceapi.detectAllFaces(
      image,
      new faceapi.TinyFaceDetectorOptions({ inputSize: 320, scoreThreshold: 0.4 })
    );
    if (!detections.length) return null;
    let best = detections[0].box;
    for (const d of detections) {
      if (d.box.width * d.box.height > best.width * best.height) {
        best = d.box;
      }
    }
    return { x: best.x, y: best.y, w: best.width, h: best.height };
  } catch {
    return null;
  }
}

/**
 * Compute the optimal source-rect to crop from ``overlay`` so the
 * resulting image fits ``target`` aspect (w/h) and keeps any detected
 * face centred in frame. Falls back to the same top-biased portrait
 * crop the heuristic uses when no face is detected.
 */
export async function computeFaceAwareCrop(
  overlay: HTMLImageElement,
  targetAspect: number
): Promise<{ sx: number; sy: number; sw: number; sh: number }> {
  const oW = overlay.naturalWidth || overlay.width;
  const oH = overlay.naturalHeight || overlay.height;
  const oAspect = oW / oH;

  // If the aspects are already close, no crop needed.
  if (Math.abs(oAspect - targetAspect) <= 0.02) {
    return { sx: 0, sy: 0, sw: oW, sh: oH };
  }

  const face = await detectLargestFace(overlay);
  // Centre of the area we want to keep visible.
  const focusX = face ? face.x + face.w / 2 : oW / 2;
  // Without a face: portrait images bias upward (heads typically in
  // the upper third); other aspects centre.
  const focusY = face
    ? face.y + face.h / 2
    : oAspect < 0.85
    ? oH * 0.30
    : oH / 2;

  let sx = 0;
  let sy = 0;
  let sw = oW;
  let sh = oH;

  if (oAspect > targetAspect) {
    // Overlay is wider than target → crop left+right around focusX.
    sw = oH * targetAspect;
    sx = clamp(focusX - sw / 2, 0, oW - sw);
  } else {
    // Overlay is taller than target → crop top+bottom around focusY.
    sh = oW / targetAspect;
    sy = clamp(focusY - sh / 2, 0, oH - sh);
  }

  return { sx, sy, sw, sh };
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}
