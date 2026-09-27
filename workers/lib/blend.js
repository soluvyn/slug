// folds an inpainted result back into the original with a feathered edge.
// runs for every algorithm

import { clampInt } from "./util.js";
import { computeMaskBounds } from "./mask.js";

function clamp01(v) {
  if (v < 0) return 0;
  if (v > 1) return 1;
  return v;
}

function smoothstep(edge0, edge1, x) {
  const t = clamp01((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

function extractAlphaRoi(mask, width, x0, y0, rw, rh) {
  const alpha = new Uint16Array(rw * rh);
  for (let ry = 0; ry < rh; ry += 1) {
    const sy = y0 + ry;
    const rowBase = (sy * width + x0) * 4;
    const outBase = ry * rw;
    for (let rx = 0; rx < rw; rx += 1) {
      alpha[outBase + rx] = mask[rowBase + rx * 4 + 3];
    }
  }
  return alpha;
}

function boxBlurUint16Separable(src, w, h, radius) {
  if (radius <= 0) return src;
  const windowSize = radius * 2 + 1;
  const tmp = new Uint16Array(w * h);
  const dst = new Uint16Array(w * h);
  for (let y = 0; y < h; y += 1) {
    const row = y * w;
    const first = src[row];
    const last = src[row + w - 1];
    let sum = first * radius;
    for (let x = 0; x <= radius; x += 1) sum += src[row + x];

    for (let x = 0; x < w; x += 1) {
      tmp[row + x] = Math.round(sum / windowSize);
      const outX = x - radius;
      const inX = x + radius + 1;
      const outV = outX < 0 ? first : src[row + outX];
      const inV = inX >= w ? last : src[row + inX];
      sum += inV - outV;
    }
  }
  for (let x = 0; x < w; x += 1) {
    const first = tmp[x];
    const last = tmp[(h - 1) * w + x];
    let sum = first * radius;
    for (let y = 0; y <= radius; y += 1) sum += tmp[y * w + x];

    for (let y = 0; y < h; y += 1) {
      dst[y * w + x] = Math.round(sum / windowSize);
      const outY = y - radius;
      const inY = y + radius + 1;
      const outV = outY < 0 ? first : tmp[outY * w + x];
      const inV = inY >= h ? last : tmp[inY * w + x];
      sum += inV - outV;
    }
  }

  return dst;
}

export function blendNaturalEdgesRGBA({
  original,
  inpainted,
  mask,
  width,
  height,
  radius,
  featherPx,
}) {
  const bounds = computeMaskBounds(mask, width, height);
  if (!bounds) return inpainted;
  const f =
    typeof featherPx === "number"
      ? clampInt(Math.round(featherPx), 1, 26)
      : clampInt(Math.round(radius * 0.35), 2, 12);
  const pad = f * 2;
  const x0 = clampInt(bounds.minX - pad, 0, width - 1);
  const y0 = clampInt(bounds.minY - pad, 0, height - 1);
  const x1 = clampInt(bounds.maxX + pad, 0, width - 1);
  const y1 = clampInt(bounds.maxY + pad, 0, height - 1);
  const rw = x1 - x0 + 1;
  const rh = y1 - y0 + 1;

  const hardAlpha = extractAlphaRoi(mask, width, x0, y0, rw, rh);
  const softAlpha = boxBlurUint16Separable(hardAlpha, rw, rh, f);

  const inv255 = 1 / 255;
  for (let ry = 0; ry < rh; ry += 1) {
    const sy = y0 + ry;
    const base = (sy * width + x0) * 4;
    const pBase = ry * rw;
    for (let rx = 0; rx < rw; rx += 1) {
      const p = pBase + rx;
      if (softAlpha[p] <= 0) continue;

      const i = base + rx * 4;
      if (hardAlpha[p] >= 255) {
        inpainted[i + 3] = 255;
        continue;
      }

      const soft = softAlpha[p] * inv255;
      const w = smoothstep(0.2, 0.95, soft);
      if (w <= 0) continue;

      const iw = 1 - w;
      inpainted[i] = Math.round(inpainted[i] * w + original[i] * iw);
      inpainted[i + 1] = Math.round(
        inpainted[i + 1] * w + original[i + 1] * iw,
      );
      inpainted[i + 2] = Math.round(
        inpainted[i + 2] * w + original[i + 2] * iw,
      );
      inpainted[i + 3] = 255;
    }
  }

  return inpainted;
}

export function keepOriginalOutsideMaskRGBA({ original, inpainted, mask }) {
  for (let i = 0; i < mask.length; i += 4) {
    if (mask[i + 3] > 0) continue;
    inpainted[i] = original[i];
    inpainted[i + 1] = original[i + 1];
    inpainted[i + 2] = original[i + 2];
    inpainted[i + 3] = 255;
  }
  return inpainted;
}
