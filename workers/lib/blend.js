// moving between the full-res image and the smaller one the fill runs on

// area-average downscale of `c` interleaved channels
export function downscale(src, W, H, w, h, c) {
  const out = new Uint8ClampedArray(w * h * c);
  const acc = new Float64Array(c);
  for (let y = 0; y < h; y += 1) {
    const sy0 = Math.floor((y * H) / h);
    const sy1 = Math.max(sy0 + 1, Math.floor(((y + 1) * H) / h));
    for (let x = 0; x < w; x += 1) {
      const sx0 = Math.floor((x * W) / w);
      const sx1 = Math.max(sx0 + 1, Math.floor(((x + 1) * W) / w));
      acc.fill(0);
      for (let sy = sy0; sy < sy1; sy += 1) {
        for (let sx = sx0; sx < sx1; sx += 1) {
          const i = (sy * W + sx) * c;
          for (let k = 0; k < c; k += 1) acc[k] += src[i + k];
        }
      }
      const n = (sy1 - sy0) * (sx1 - sx0);
      const o = (y * w + x) * c;
      for (let k = 0; k < c; k += 1) out[o + k] = acc[k] / n;
    }
  }
  return out;
}

// the patch `rect` of `original` with the w×h `fill` eased in by `weight`
// (0-255 per patch pixel). the fill is sampled bilinearly, so outside the
// weighted area the patch is the untouched full-res original
export function compose(original, W, H, fill, w, h, rect, weight) {
  const out = new Uint8ClampedArray(rect.w * rect.h * 4);
  const sx = w / W;
  const sy = h / H;
  for (let ry = 0, p = 0; ry < rect.h; ry += 1) {
    const fy = Math.min(h - 1, Math.max(0, (rect.y + ry + 0.5) * sy - 0.5));
    const y0 = fy | 0;
    const y1 = Math.min(y0 + 1, h - 1);
    const ty = fy - y0;
    for (let rx = 0; rx < rect.w; rx += 1, p += 1) {
      const i = ((rect.y + ry) * W + rect.x + rx) * 4;
      const o = p * 4;
      const a = weight[p] / 255;
      if (a === 0) {
        out.set(original.subarray(i, i + 4), o);
        continue;
      }
      const fx = Math.min(w - 1, Math.max(0, (rect.x + rx + 0.5) * sx - 0.5));
      const x0 = fx | 0;
      const x1 = Math.min(x0 + 1, w - 1);
      const tx = fx - x0;
      const i00 = (y0 * w + x0) * 4, i01 = (y0 * w + x1) * 4;
      const i10 = (y1 * w + x0) * 4, i11 = (y1 * w + x1) * 4;
      for (let k = 0; k < 3; k += 1) {
        const top = fill[i00 + k] + (fill[i01 + k] - fill[i00 + k]) * tx;
        const bottom = fill[i10 + k] + (fill[i11 + k] - fill[i10 + k]) * tx;
        const v = top + (bottom - top) * ty;
        out[o + k] = original[i + k] + (v - original[i + k]) * a;
      }
      // the fill is opaque, so a hole in a transparent area comes out opaque
      out[o + 3] = original[i + 3] + (255 - original[i + 3]) * a;
    }
  }
  return out;
}
