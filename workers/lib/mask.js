// masks here are one byte per pixel, nonzero = remove

export function alphaOf(rgba) {
  const out = new Uint8Array(rgba.length >> 2);
  for (let p = 0, i = 3; p < out.length; p += 1, i += 4) out[p] = rgba[i];
  return out;
}

export function bounds(mask, width, height) {
  let x0 = width, y0 = height, x1 = -1, y1 = -1;
  for (let y = 0, p = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1, p += 1) {
      if (!mask[p]) continue;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      y1 = y;
    }
  }
  return x1 < 0 ? null : { x0, y0, x1, y1 };
}

// box sums over a (2r+1)² window, edges clamped. kept unnormalised so integer
// input stays exact: a running float average drifts, and a "> 0" test on it
// then smears the mask down a whole row
export function boxSum(src, w, h, r) {
  const tmp = new Uint32Array(w * h);
  const out = new Uint32Array(w * h);
  sumLines(src, tmp, w, h, w, 1, r);
  sumLines(tmp, out, h, w, 1, w, r);
  return out;
}

// `lines` runs of `len` samples, `step` apart within a run and `stride` apart between runs
function sumLines(src, dst, len, lines, stride, step, r) {
  for (let l = 0; l < lines; l += 1) {
    const base = l * stride;
    const at = (k) => src[base + (k < 0 ? 0 : k >= len ? len - 1 : k) * step];
    let sum = 0;
    for (let k = -r; k <= r; k += 1) sum += at(k);
    for (let k = 0; k < len; k += 1) {
      dst[base + k * step] = sum;
      sum += at(k + r + 1) - at(k - r);
    }
  }
}

// nonzero wherever `mask` is within `r` px (chebyshev)
export function dilate(mask, w, h, r) {
  const sums = boxSum(mask, w, h, r);
  const out = new Uint8Array(w * h);
  for (let p = 0; p < out.length; p += 1) out[p] = sums[p] ? 255 : 0;
  return out;
}

// how much of the fill each pixel of `rect` takes, 0-255: all of it on the
// mask, easing to none `f` px outside it
export function featherWeights(mask, width, rect, f) {
  const { x, y, w, h } = rect;
  const local = new Uint8Array(w * h);
  for (let ry = 0; ry < h; ry += 1) {
    const row = (y + ry) * width + x;
    local.set(mask.subarray(row, row + w), ry * w);
  }
  const sums = boxSum(local, w, h, f);
  // half coverage is the mask edge, so that maps to 1
  const norm = 2 / (255 * (2 * f + 1) ** 2);
  const out = new Uint8Array(w * h);
  for (let p = 0; p < out.length; p += 1) {
    const t = Math.min(1, sums[p] * norm);
    out[p] = Math.max(local[p], 255 * t * t * (3 - 2 * t));
  }
  return out;
}
