// harmonic (laplace) fill, diffusing known pixels inward. the unconditional
// fallback when telea and patchmatch are both unavailable

import { clampInt } from "./util.js";
import { computeMaskBounds } from "./mask.js";

export function harmonicInpaintRGBA({ image, mask, width, height, radius, bounds }) {
  const finalBounds = bounds ?? computeMaskBounds(mask, width, height);
  if (!finalBounds) return new Uint8ClampedArray(image);

  const pad = clampInt(Math.floor(16 + radius * 10), 16, 128);
  const x0 = clampInt(finalBounds.minX - pad, 0, width - 1);
  const y0 = clampInt(finalBounds.minY - pad, 0, height - 1);
  const x1 = clampInt(finalBounds.maxX + pad, 0, width - 1);
  const y1 = clampInt(finalBounds.maxY + pad, 0, height - 1);

  const rw = x1 - x0 + 1;
  const rh = y1 - y0 + 1;
  const regionPixels = rw * rh;

  const regionMask = new Uint8Array(regionPixels);
  const fixed = new Uint8Array(regionPixels);
  const prev = new Float32Array(regionPixels * 3);

  for (let ry = 0; ry < rh; ry += 1) {
    const sy = y0 + ry;
    for (let rx = 0; rx < rw; rx += 1) {
      const sx = x0 + rx;
      const srcI = (sy * width + sx) * 4;
      const dstP = ry * rw + rx;
      const dstI = dstP * 3;

      const m = mask[srcI + 3] > 0 ? 1 : 0;
      regionMask[dstP] = m;
      fixed[dstP] = m ? 0 : 1;

      prev[dstI] = image[srcI];
      prev[dstI + 1] = image[srcI + 1];
      prev[dstI + 2] = image[srcI + 2];
    }
  }

  for (let ry = 0; ry < rh; ry += 1) {
    for (let rx = 0; rx < rw; rx += 1) {
      const p = ry * rw + rx;
      if (!regionMask[p]) continue;

      let sumR = 0;
      let sumG = 0;
      let sumB = 0;
      let count = 0;

      for (let oy = -1; oy <= 1; oy += 1) {
        const ny = ry + oy;
        if (ny < 0 || ny >= rh) continue;
        for (let ox = -1; ox <= 1; ox += 1) {
          const nx = rx + ox;
          if (nx < 0 || nx >= rw) continue;
          const np = ny * rw + nx;
          if (!fixed[np]) continue;
          const ni = np * 3;
          sumR += prev[ni];
          sumG += prev[ni + 1];
          sumB += prev[ni + 2];
          count += 1;
        }
      }

      if (count > 0) {
        const i = p * 3;
        prev[i] = sumR / count;
        prev[i + 1] = sumG / count;
        prev[i + 2] = sumB / count;
      }
    }
  }

  const iter =
    260 +
    clampInt(Math.floor(Math.sqrt(regionPixels) * 10), 0, 1500) +
    clampInt(Math.floor(radius * 70), 0, 1200);
  const iterations = clampInt(iter, 400, 2600);
  
  const omega = 1.85;

  for (let t = 0; t < iterations; t += 1) {
    for (let ry = 0; ry < rh; ry += 1) {
      const rowOffset = ry * rw;
      for (let rx = 0; rx < rw; rx += 1) {
        const p = rowOffset + rx;
        const i = p * 3;

        if (fixed[p]) continue;

        const up = ry > 0 ? p - rw : p;
        const down = ry < rh - 1 ? p + rw : p;
        const left = rx > 0 ? p - 1 : p;
        const right = rx < rw - 1 ? p + 1 : p;

        const iu = up * 3;
        const id = down * 3;
        const il = left * 3;
        const ir = right * 3;

        const avgR = (prev[iu] + prev[id] + prev[il] + prev[ir]) * 0.25;
        const avgG =
          (prev[iu + 1] + prev[id + 1] + prev[il + 1] + prev[ir + 1]) * 0.25;
        const avgB =
          (prev[iu + 2] + prev[id + 2] + prev[il + 2] + prev[ir + 2]) * 0.25;

        prev[i] = prev[i] + (avgR - prev[i]) * omega;
        prev[i + 1] = prev[i + 1] + (avgG - prev[i + 1]) * omega;
        prev[i + 2] = prev[i + 2] + (avgB - prev[i + 2]) * omega;
      }
    }
  }

  const out = new Uint8ClampedArray(image);
  for (let ry = 0; ry < rh; ry += 1) {
    const sy = y0 + ry;
    for (let rx = 0; rx < rw; rx += 1) {
      const p = ry * rw + rx;
      if (fixed[p]) continue;
      const srcI = (sy * width + (x0 + rx)) * 4;
      const i = p * 3;
      out[srcI] = clampInt(Math.round(prev[i]), 0, 255);
      out[srcI + 1] = clampInt(Math.round(prev[i + 1]), 0, 255);
      out[srcI + 2] = clampInt(Math.round(prev[i + 2]), 0, 255);
      out[srcI + 3] = 255;
    }
  }

  return out;
}
