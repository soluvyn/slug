// numeric helpers shared by every inpainting kernel

export function clampInt(v, min, max) {
  if (v < min) return min;
  if (v > max) return max;
  return v;
}
