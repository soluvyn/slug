// mask-space queries: bounds and the summed-area table the patch sampler uses
// to ask "is this rectangle free of mask?" in constant time

export function hasAnyMask(mask) {
  for (let i = 3; i < mask.length; i += 4) {
    if (mask[i] > 0) return true;
  }
  return false;
}

export function computeMaskBounds(mask, width, height) {
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;

  for (let y = 0; y < height; y += 1) {
    const rowBase = y * width * 4;
    for (let x = 0; x < width; x += 1) {
      const a = mask[rowBase + x * 4 + 3];
      if (a <= 0) continue;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }

  if (maxX < 0) return null;
  return { minX, minY, maxX, maxY };
}

export function buildMaskIntegral(mask, width, height, x0, y0, rw, rh) {
  const stride = rw + 1;
  const integral = new Uint32Array((rw + 1) * (rh + 1));

  for (let y = 1; y <= rh; y += 1) {
    let rowSum = 0;
    const sy = y0 + (y - 1);
    const srcRow = sy * width * 4;
    const dstRow = y * stride;
    const prevRow = (y - 1) * stride;

    for (let x = 1; x <= rw; x += 1) {
      const sx = x0 + (x - 1);
      const a = mask[srcRow + sx * 4 + 3] > 0 ? 1 : 0;
      rowSum += a;
      integral[dstRow + x] = integral[prevRow + x] + rowSum;
    }
  }

  return { integral, stride };
}

export function maskCountInRect(integral, stride, x0, y0, x1, y1) {
  const ax0 = x0;
  const ay0 = y0;
  const ax1 = x1 + 1;
  const ay1 = y1 + 1;
  const a = integral[ay0 * stride + ax0];
  const b = integral[ay0 * stride + ax1];
  const c = integral[ay1 * stride + ax0];
  const d = integral[ay1 * stride + ax1];
  return d - b - c + a;
}
