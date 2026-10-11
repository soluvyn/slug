// pure-js fallback for when opencv will not load: fill the hole ring by ring
// from its edge inward, then smooth it towards a harmonic (laplace) fill

import { bounds } from "./mask.js";

const OMEGA = 1.8;
const MAX_SWEEPS = 400;

export function harmonicInpaint(image, hole, width, height, budgetMs = 1500) {
  const out = new Uint8ClampedArray(image);
  const b = bounds(hole, width, height);
  if (!b) return out;

  // the hole's bounding box plus a ring of known pixels around it
  const x0 = Math.max(0, b.x0 - 1), y0 = Math.max(0, b.y0 - 1);
  const w = Math.min(width - 1, b.x1 + 1) - x0 + 1;
  const h = Math.min(height - 1, b.y1 + 1) - y0 + 1;
  const val = new Float32Array(w * h * 3);
  const known = new Uint8Array(w * h);
  for (let ry = 0, p = 0; ry < h; ry += 1) {
    for (let rx = 0; rx < w; rx += 1, p += 1) {
      const i = ((y0 + ry) * width + x0 + rx) * 4;
      val.set(image.subarray(i, i + 3), p * 3);
      known[p] = hole[(y0 + ry) * width + x0 + rx] ? 0 : 1;
    }
  }

  const neighbours = (p, fn) => {
    const rx = p % w, ry = (p - rx) / w;
    for (let dy = -1; dy <= 1; dy += 1) {
      for (let dx = -1; dx <= 1; dx += 1) {
        const nx = rx + dx, ny = ry + dy;
        if ((dx || dy) && nx >= 0 && nx < w && ny >= 0 && ny < h) fn(ny * w + nx);
      }
    }
  };

  // onion peel: each ring takes the mean of the pixels already known
  const order = [];
  const queued = new Uint8Array(w * h);
  const enqueue = (list, p) => {
    if (known[p] || queued[p]) return;
    queued[p] = 1;
    list.push(p);
  };
  let ring = [];
  for (let p = 0; p < known.length; p += 1) {
    if (known[p]) neighbours(p, (n) => enqueue(ring, n));
  }
  while (ring.length) {
    for (const p of ring) {
      let r = 0, g = 0, bl = 0, n = 0;
      neighbours(p, (q) => {
        if (!known[q]) return;
        r += val[q * 3];
        g += val[q * 3 + 1];
        bl += val[q * 3 + 2];
        n += 1;
      });
      val[p * 3] = r / n;
      val[p * 3 + 1] = g / n;
      val[p * 3 + 2] = bl / n;
    }
    const next = [];
    for (const p of ring) known[p] = 1;
    for (const p of ring) {
      order.push(p);
      neighbours(p, (n) => enqueue(next, n));
    }
    ring = next;
  }

  // successive over-relaxation, hole pixels only
  const deadline = performance.now() + budgetMs;
  for (let s = 0; s < MAX_SWEEPS && performance.now() < deadline; s += 1) {
    for (const p of order) {
      const rx = p % w;
      const up = p >= w ? p - w : p, down = p + w < w * h ? p + w : p;
      const left = rx > 0 ? p - 1 : p, right = rx < w - 1 ? p + 1 : p;
      for (let k = 0; k < 3; k += 1) {
        const avg = (val[up * 3 + k] + val[down * 3 + k] + val[left * 3 + k] + val[right * 3 + k]) / 4;
        val[p * 3 + k] += (avg - val[p * 3 + k]) * OMEGA;
      }
    }
  }

  for (const p of order) {
    const rx = p % w, ry = (p - rx) / w;
    const i = ((y0 + ry) * width + x0 + rx) * 4;
    out[i] = val[p * 3];
    out[i + 1] = val[p * 3 + 1];
    out[i + 2] = val[p * 3 + 2];
    out[i + 3] = 255;
  }
  return out;
}
