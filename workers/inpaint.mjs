// jobs arrive as the full-res image and mask and go back as the patch that
// changed. the fill runs on a copy no larger than MAX_EDGE, then is eased
// back into the full-res original, so pixels away from the mask never move
//   standard: opencv telea, or a harmonic fill if opencv will not load
//   pro: mi-gan, in a nested worker

import { alphaOf, bounds, dilate, featherWeights } from "./lib/mask.js";
import { downscale, compose } from "./lib/blend.js";
import { teleaInpaint } from "./lib/inpaint-telea.js";
import { harmonicInpaint } from "./lib/inpaint-harmonic.js";

const MAX_EDGE = 2048;
const MIGAN_TIMEOUT_MS = 60_000;

let migan = null;
let callId = 0;
const calls = new Map();

function callMigan(msg, transfer = [], timeoutMs = 0) {
  if (!migan) {
    migan = new Worker(new URL("./migan.js", import.meta.url));
    migan.onmessage = ({ data }) => calls.get(data.id)?.(data);
    migan.onerror = (e) => {
      e.preventDefault();
      resetMigan(e.message || "MI-GAN worker crashed");
    };
  }
  return new Promise((resolve, reject) => {
    const id = ++callId;
    const timer = timeoutMs && setTimeout(() => resetMigan(`MI-GAN timed out after ${timeoutMs / 1000}s`), timeoutMs);
    calls.set(id, (res) => {
      calls.delete(id);
      clearTimeout(timer);
      res.ok ? resolve(res) : reject(new Error(res.error));
    });
    migan.postMessage({ ...msg, id }, transfer);
  });
}

// a crashed or stuck worker is dropped whole, so a late reply can never land
// on the next job. the next call spawns a fresh one
function resetMigan(error) {
  migan?.terminate();
  migan = null;
  for (const settle of calls.values()) settle({ ok: false, error });
}

async function fillPro(image, hole, w, h) {
  // the first load is a ~28MB download, so only inference is timed
  await callMigan({ type: "load" });
  const copy = image.slice();
  const res = await callMigan({ type: "inpaint", image: copy, hole, width: w, height: h }, [copy.buffer, hole.buffer], MIGAN_TIMEOUT_MS);
  return res.image;
}

async function fillStandard(image, hole, w, h, radius) {
  try {
    // telea costs radius² per pixel and only blurs more past a few px: at the
    // brush's 80 px it took over a minute
    return await teleaInpaint(image, hole, w, h, Math.min(6, Math.max(3, Math.round(radius))));
  } catch (err) {
    console.warn("[inpaint] opencv unavailable, using harmonic fill:", err);
    return harmonicInpaint(image, hole, w, h);
  }
}

async function run({ image, mask: rgbaMask, width, height, radius, quality }) {
  const mask = alphaOf(rgbaMask);
  const b = bounds(mask, width, height);
  if (!b) return null;

  // the fill eases into the original over this many px outside the mask
  const feather = Math.min(26, Math.max(2, Math.round(radius * 0.3)));
  const x = Math.max(0, b.x0 - feather - 1), y = Math.max(0, b.y0 - feather - 1);
  const rect = {
    x,
    y,
    w: Math.min(width - 1, b.x1 + feather + 1) - x + 1,
    h: Math.min(height - 1, b.y1 + feather + 1) - y + 1,
  };

  const scale = Math.min(1, MAX_EDGE / width, MAX_EDGE / height);
  const w = Math.max(1, Math.round(width * scale));
  const h = Math.max(1, Math.round(height * scale));
  const small = scale < 1;
  const workImage = small ? downscale(image, width, height, w, h, 4) : image;
  const workMask = small ? downscale(mask, width, height, w, h, 1) : mask;
  // the feather ring is filled too, or there is nothing to ease into
  const hole = dilate(workMask, w, h, Math.ceil(feather * scale) + 2);

  const fill =
    quality === "pro"
      ? await fillPro(workImage, hole, w, h)
      : await fillStandard(workImage, hole, w, h, radius * scale);
  const weight = featherWeights(mask, width, rect, feather);
  return { x, y, width: rect.w, height: rect.h, data: compose(image, width, height, fill, w, h, rect, weight) };
}

self.onmessage = async ({ data }) => {
  if (data.type === "warmup") {
    // errors resurface on the real job, which retries the load
    callMigan({ type: "load" }).catch(() => {});
    return;
  }
  try {
    const patch = await run(data);
    self.postMessage({ id: data.id, ok: true, patch }, patch ? [patch.data.buffer] : []);
  } catch (err) {
    self.postMessage({ id: data.id, ok: false, error: err?.message || String(err) });
  }
};
