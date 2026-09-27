// patchmatch inpainting, plus the heuristic gating whether it runs at all

import { clampInt } from "./util.js";
import { computeMaskBounds, buildMaskIntegral, maskCountInRect } from "./mask.js";

function createRng(seed) {
  let state = seed >>> 0;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 4294967296;
  };
}

function computeRectRingStatsRGBA({ image, mask, width, bounds, band }) {
  const x0 = clampInt(bounds.minX - band, 0, width - 1);
  const y0 = clampInt(bounds.minY - band, 0, bounds.minY);
  const x1 = clampInt(bounds.maxX + band, 0, width - 1);
  const y1 = clampInt(bounds.maxY + band, bounds.maxY, bounds.maxY + band);

  let ringR = 0;
  let ringG = 0;
  let ringB = 0;
  let ringCount = 0;

  let sumL = 0;
  let sumL2 = 0;

  let maskedR = 0;
  let maskedG = 0;
  let maskedB = 0;
  let maskedCount = 0;

  for (let y = y0; y <= y1; y += 1) {
    const row = y * width * 4;
    const inY = y >= bounds.minY && y <= bounds.maxY;
    for (let x = x0; x <= x1; x += 1) {
      const inX = x >= bounds.minX && x <= bounds.maxX;
      const inside = inX && inY;
      const i = row + x * 4;

      if (inside) {
        if (mask[i + 3] <= 0) continue;
        maskedR += image[i];
        maskedG += image[i + 1];
        maskedB += image[i + 2];
        maskedCount += 1;
        continue;
      }

      if (mask[i + 3] > 0) continue;

      const r = image[i];
      const g = image[i + 1];
      const b = image[i + 2];
      ringR += r;
      ringG += g;
      ringB += b;
      ringCount += 1;

      const l = (r * 54 + g * 183 + b * 19) >> 8;
      sumL += l;
      sumL2 += l * l;
    }
  }

  if (maskedCount === 0 || ringCount === 0) {
    return null;
  }

  const mr = maskedR / maskedCount;
  const mg = maskedG / maskedCount;
  const mb = maskedB / maskedCount;

  const rr = ringR / ringCount;
  const rg = ringG / ringCount;
  const rb = ringB / ringCount;

  const diff = (Math.abs(mr - rr) + Math.abs(mg - rg) + Math.abs(mb - rb)) / 3;

  const meanL = sumL / ringCount;
  const varL = sumL2 / ringCount - meanL * meanL;

  return { diff, varL, maskedCount, ringCount };
}

function quickFillMaskedRGBA({ image, mask, width, x0, y0, rw, rh }) {
  const out = new Uint8ClampedArray(image);

  let sumR = 0;
  let sumG = 0;
  let sumB = 0;
  let count = 0;

  for (let ry = 0; ry < rh; ry += 1) {
    const sy = y0 + ry;
    const row = sy * width * 4;
    for (let rx = 0; rx < rw; rx += 1) {
      const sx = x0 + rx;
      const i = row + sx * 4;
      if (mask[i + 3] > 0) continue;
      sumR += out[i];
      sumG += out[i + 1];
      sumB += out[i + 2];
      count += 1;
    }
  }

  if (count === 0) return out;

  const avgR = Math.round(sumR / count);
  const avgG = Math.round(sumG / count);
  const avgB = Math.round(sumB / count);

  for (let ry = 0; ry < rh; ry += 1) {
    const sy = y0 + ry;
    const row = sy * width * 4;
    for (let rx = 0; rx < rw; rx += 1) {
      const sx = x0 + rx;
      const i = row + sx * 4;
      if (mask[i + 3] <= 0) continue;
      out[i] = avgR;
      out[i + 1] = avgG;
      out[i + 2] = avgB;
      out[i + 3] = 255;
    }
  }

  return out;
}

function isPatchMatchSourceValid(ctx, cx, cy) {
  if (cx < ctx.minCx || cx > ctx.maxCx || cy < ctx.minCy || cy > ctx.maxCy)
    return false;
  const xA = cx - ctx.patchRadius;
  const yA = cy - ctx.patchRadius;
  const xB = cx + ctx.patchRadius;
  const yB = cy + ctx.patchRadius;
  return maskCountInRect(ctx.integral, ctx.stride, xA, yA, xB, yB) === 0;
}

function calcPatchMatchDistance(ctx, tx, ty, sx, sy, bestSoFar) {
  let dist = 0;
  const maskedWeight = 0.15;
  for (let dy = -ctx.patchRadius; dy <= ctx.patchRadius; dy += 1) {
    const tY = ty + dy;
    const sY = sy + dy;
    const tRow = (ctx.y0 + tY) * ctx.width * 4;
    const sRow = (ctx.y0 + sY) * ctx.width * 4;

    for (let dx = -ctx.patchRadius; dx <= ctx.patchRadius; dx += 1) {
      const tX = tx + dx;
      const sX = sx + dx;

      const tIdx = tRow + (ctx.x0 + tX) * 4;
      const w = ctx.mask[tIdx + 3] > 0 ? maskedWeight : 1;

      const sIdx = sRow + (ctx.x0 + sX) * 4;

      const dr = ctx.work[tIdx] - ctx.work[sIdx];
      const dg = ctx.work[tIdx + 1] - ctx.work[sIdx + 1];
      const db = ctx.work[tIdx + 2] - ctx.work[sIdx + 2];
      dist += w * (dr * dr + dg * dg + db * db);

      if (dist >= bestSoFar) return dist;
    }
  }
  return dist;
}

function tryPatchMatchUpdate(ctx, tx, ty, idx, sx, sy) {
  if (!isPatchMatchSourceValid(ctx, sx, sy)) return;
  const best = ctx.nnfD[idx];
  const d = calcPatchMatchDistance(ctx, tx, ty, sx, sy, best);
  if (d < best) {
    ctx.nnfD[idx] = d;
    ctx.nnfX[idx] = sx;
    ctx.nnfY[idx] = sy;
  }
}

export function patchMatchInpaintRGBA({ image, mask, width, height, radius, bounds }) {
  const finalBounds = bounds ?? computeMaskBounds(mask, width, height);
  if (!finalBounds) return new Uint8ClampedArray(image);

  const patchRadius = clampInt(Math.round(radius), 3, 6);

  const pad = clampInt(Math.floor(24 + patchRadius * 12), 24, 160);
  const x0 = clampInt(finalBounds.minX - pad, 0, width - 1);
  const y0 = clampInt(finalBounds.minY - pad, 0, height - 1);
  const x1 = clampInt(finalBounds.maxX + pad, 0, width - 1);
  const y1 = clampInt(finalBounds.maxY + pad, 0, height - 1);

  const rw = x1 - x0 + 1;
  const rh = y1 - y0 + 1;

  const maxPixels = 160_000;
  if (rw * rh > maxPixels) return null;

  const work = quickFillMaskedRGBA({ image, mask, width, x0, y0, rw, rh });

  const { integral, stride } = buildMaskIntegral(
    mask,
    width,
    height,
    x0,
    y0,
    rw,
    rh,
  );

  const minCx = patchRadius;
  const maxCx = rw - 1 - patchRadius;
  const minCy = patchRadius;
  const maxCy = rh - 1 - patchRadius;
  if (maxCx < minCx || maxCy < minCy) return null;

  const countW = rw;
  const countH = rh;
  const nnfX = new Int16Array(countW * countH);
  const nnfY = new Int16Array(countW * countH);
  const nnfD = new Float32Array(countW * countH);

  const ctx = {
    minCx,
    maxCx,
    minCy,
    maxCy,
    patchRadius,
    width,
    x0,
    y0,
    mask,
    work,
    integral,
    stride,
    nnfD,
    nnfX,
    nnfY,
  };

  const validSources = [];
  for (let cy = minCy; cy <= maxCy; cy += 1) {
    for (let cx = minCx; cx <= maxCx; cx += 1) {
      if (isPatchMatchSourceValid(ctx, cx, cy)) {
        validSources.push([cx, cy]);
      }
    }
  }
  if (validSources.length === 0) return null;

  const rng = createRng(1337);

  for (let y = 0; y < countH; y += 1) {
    for (let x = 0; x < countW; x += 1) {
      const idx = y * countW + x;
      nnfD[idx] = Number.POSITIVE_INFINITY;

      const cx = x;
      const cy = y;

      if (cx < minCx || cx > maxCx || cy < minCy || cy > maxCy) {
        nnfX[idx] = minCx;
        nnfY[idx] = minCy;
        continue;
      }

      if (isPatchMatchSourceValid(ctx, cx, cy)) {
        nnfX[idx] = cx;
        nnfY[idx] = cy;
        nnfD[idx] = 0;
        continue;
      }

      const pick = validSources[(rng() * validSources.length) | 0];
      nnfX[idx] = pick[0];
      nnfY[idx] = pick[1];
      nnfD[idx] = calcPatchMatchDistance(
        ctx,
        cx,
        cy,
        nnfX[idx],
        nnfY[idx],
        Number.POSITIVE_INFINITY,
      );
    }
  }

  const start = Date.now();
  const timeBudgetMs = 1400;
  const iterations = 7;

  for (let it = 0; it < iterations; it += 1) {
    const forward = it % 2 === 0;
    const yStart = forward ? minCy : maxCy;
    const yEnd = forward ? maxCy : minCy;
    const yStep = forward ? 1 : -1;
    const xStart = forward ? minCx : maxCx;
    const xEnd = forward ? maxCx : minCx;
    const xStep = forward ? 1 : -1;

    for (let y = yStart; forward ? y <= yEnd : y >= yEnd; y += yStep) {
      for (let x = xStart; forward ? x <= xEnd : x >= xEnd; x += xStep) {
        const idx = y * countW + x;

        if (forward) {
          if (x - 1 >= minCx) {
            const leftIdx = y * countW + (x - 1);
            tryPatchMatchUpdate(
              ctx,
              x,
              y,
              idx,
              nnfX[leftIdx] + 1,
              nnfY[leftIdx],
            );
          }
          if (y - 1 >= minCy) {
            const upIdx = (y - 1) * countW + x;
            tryPatchMatchUpdate(ctx, x, y, idx, nnfX[upIdx], nnfY[upIdx] + 1);
          }
        } else {
          if (x + 1 <= maxCx) {
            const rightIdx = y * countW + (x + 1);
            tryPatchMatchUpdate(
              ctx,
              x,
              y,
              idx,
              nnfX[rightIdx] - 1,
              nnfY[rightIdx],
            );
          }
          if (y + 1 <= maxCy) {
            const downIdx = (y + 1) * countW + x;
            tryPatchMatchUpdate(
              ctx,
              x,
              y,
              idx,
              nnfX[downIdx],
              nnfY[downIdx] - 1,
            );
          }
        }
        
        let rs = Math.max(rw, rh);
        let bestX = nnfX[idx];
        let bestY = nnfY[idx];
        while (rs >= 1) {
          const minXr = clampInt(bestX - rs, minCx, maxCx);
          const maxXr = clampInt(bestX + rs, minCx, maxCx);
          const minYr = clampInt(bestY - rs, minCy, maxCy);
          const maxYr = clampInt(bestY + rs, minCy, maxCy);

          const candX = clampInt(
            (minXr + rng() * (maxXr - minXr + 1)) | 0,
            minCx,
            maxCx,
          );
          const candY = clampInt(
            (minYr + rng() * (maxYr - minYr + 1)) | 0,
            minCy,
            maxCy,
          );

          tryPatchMatchUpdate(ctx, x, y, idx, candX, candY);

          bestX = nnfX[idx];
          bestY = nnfY[idx];
          rs = (rs * 0.5) | 0;
        }

        if (Date.now() - start > timeBudgetMs) break;
      }
      if (Date.now() - start > timeBudgetMs) break;
    }
    if (Date.now() - start > timeBudgetMs) break;
  }

  const out = new Uint8ClampedArray(work);
  const weightScale = 50_000;

  for (let ry = 0; ry < rh; ry += 1) {
    const sy = y0 + ry;
    const srcRow = sy * width * 4;
    for (let rx = 0; rx < rw; rx += 1) {
      const sx = x0 + rx;
      const idx = srcRow + sx * 4;
      if (mask[idx + 3] <= 0) continue;

      let sumR = 0;
      let sumG = 0;
      let sumB = 0;
      let sumW = 0;

      const cxMin = clampInt(rx - patchRadius, minCx, maxCx);
      const cxMax = clampInt(rx + patchRadius, minCx, maxCx);
      const cyMin = clampInt(ry - patchRadius, minCy, maxCy);
      const cyMax = clampInt(ry + patchRadius, minCy, maxCy);

      for (let cy = cyMin; cy <= cyMax; cy += 1) {
        for (let cx = cxMin; cx <= cxMax; cx += 1) {
          const pIdx = cy * countW + cx;
          const mapCx = nnfX[pIdx];
          const mapCy = nnfY[pIdx];
          const ox = rx - cx;
          const oy = ry - cy;
          const srcX = mapCx + ox;
          const srcY = mapCy + oy;

          if (srcX < 0 || srcX >= rw || srcY < 0 || srcY >= rh) continue;

          const gi = (y0 + srcY) * width * 4 + (x0 + srcX) * 4;
          if (mask[gi + 3] > 0) continue;

          const w = 1 / (1 + nnfD[pIdx] / weightScale);
          sumR += work[gi] * w;
          sumG += work[gi + 1] * w;
          sumB += work[gi + 2] * w;
          sumW += w;
        }
      }

      if (sumW > 0) {
        out[idx] = clampInt(Math.round(sumR / sumW), 0, 255);
        out[idx + 1] = clampInt(Math.round(sumG / sumW), 0, 255);
        out[idx + 2] = clampInt(Math.round(sumB / sumW), 0, 255);
        out[idx + 3] = 255;
      }
    }
  }

  return out;
}

// needs a large textured ring and a masked region that contrasts with it, or a
// plain harmonic fill is faster and less artefact-prone
export function shouldUsePatchMatch({ image, mask, width, bounds, radius }) {
  const patchRadius = clampInt(Math.round(radius), 3, 6);
  const band = clampInt(10 + patchRadius * 3, 10, 40);
  const stats = computeRectRingStatsRGBA({ image, mask, width, bounds, band });
  return !!(
    stats &&
    stats.ringCount > 400 &&
    stats.maskedCount > 50 &&
    stats.diff > 36 &&
    stats.varL > 650
  );
}
