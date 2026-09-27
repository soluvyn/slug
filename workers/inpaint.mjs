// message contract and fallback chain. the algorithms live in ./lib

// standard: telea -> (heuristic) patchmatch -> harmonic
// pro: mi-gan

import { hasAnyMask, computeMaskBounds } from "./lib/mask.js";
import { blendNaturalEdgesRGBA, keepOriginalOutsideMaskRGBA } from "./lib/blend.js";
import { tryOpenCvInpaint } from "./lib/inpaint-telea.js";
import {
  shouldUsePatchMatch,
  patchMatchInpaintRGBA,
} from "./lib/inpaint-patchmatch.js";
import { harmonicInpaintRGBA } from "./lib/inpaint-harmonic.js";

let miganWorker = null;

function getMiganWorker() {
  if (miganWorker) return miganWorker;
  try {
    miganWorker = new Worker("/workers/migan.js");
    return miganWorker;
  } catch (err) {
    console.warn("[Worker] Failed to create MI-GAN worker:", err);
    return null;
  }
}

async function checkMiganReady() {
  const worker = getMiganWorker();
  if (!worker) return false;

  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      console.warn("[Worker] MI-GAN readiness check timed out");
      resolve(false);
    }, 5000);

    const handler = (e) => {
      if (e.data.type === "check") {
        clearTimeout(timeout);
        worker.removeEventListener("message", handler);
        resolve(e.data.ready);
      }
    };

    worker.addEventListener("message", handler);
    worker.postMessage({ type: "check" });
  });
}

// returns { data } on success or { error } on failure, so the reason reaches the
// page instead of collapsing into a generic PRO_NOT_READY
async function tryMiganInpaint({ image, mask, width, height }) {
  try {
    const ready = await checkMiganReady();
    if (!ready) {
      return { error: "MI-GAN model is not reachable" };
    }

    const worker = getMiganWorker();
    if (!worker) {
      return { error: "MI-GAN worker could not be created" };
    }

    return await new Promise((resolve) => {
      const timeout = setTimeout(() => {
        resolve({ error: "MI-GAN timed out after 60s" });
      }, 60000);

      const handler = (e) => {
        if (e.data.type === "result") {
          clearTimeout(timeout);
          worker.removeEventListener("message", handler);
          if (e.data.ok) {
            resolve({ data: new Uint8ClampedArray(e.data.image) });
          } else {
            resolve({ error: e.data.error || "MI-GAN inference failed" });
          }
        }
      };

      worker.addEventListener("message", handler);
      const imageCopy = new Uint8ClampedArray(image);
      const maskCopy = new Uint8ClampedArray(mask);
      worker.postMessage(
        { type: "inpaint", image: imageCopy, mask: maskCopy, width, height },
        [imageCopy.buffer, maskCopy.buffer],
      );
    });
  } catch (err) {
    return { error: err && err.message ? err.message : String(err) };
  }
}

function reply(message, buffer) {
  self.postMessage(message, buffer ? [buffer] : []);
}

self.addEventListener("message", async (event) => {
  const data = event.data;
  if (!data || data.type !== "inpaint") return;

  const requestId = data.requestId;
  const width = data.width;
  const height = data.height;
  const radius = typeof data.radius === "number" ? data.radius : 3;
  const quality = data.quality === "pro" ? "pro" : "standard";
  const edgeFeatherPx =
    typeof data.edgeFeatherPx === "number" ? data.edgeFeatherPx : undefined;
  const image = data.image;
  const mask = data.mask;

  try {
    if (!width || !height) throw new Error("Invalid image size");
    if (!image || !mask) throw new Error("Missing image/mask data");

    if (!hasAnyMask(mask)) {
      const passthrough = new Uint8ClampedArray(image);
      reply({ ok: true, image: passthrough, width, height, requestId, quality });
      return;
    }

    if (quality === "pro") {
      const attempt = await tryMiganInpaint({ image, mask, width, height });
      if (!attempt.data) {
        reply({
          ok: false,
          error: attempt.error || "PRO_NOT_READY",
          requestId,
        });
        return;
      }
      const out = attempt.data;

      keepOriginalOutsideMaskRGBA({ original: image, inpainted: out, mask });
      const blended = blendNaturalEdgesRGBA({
        original: image,
        inpainted: out,
        mask,
        width,
        height,
        radius,
        featherPx: edgeFeatherPx,
      });
      reply(
        {
          ok: true,
          image: blended,
          width,
          height,
          method: "migan",
          quality: "pro",
          requestId,
        },
        blended.buffer,
      );
      return;
    }

    const opencvOut = await tryOpenCvInpaint({
      image,
      mask,
      width,
      height,
      radius,
    });
    if (opencvOut) {
      const blended = blendNaturalEdgesRGBA({
        original: image,
        inpainted: opencvOut,
        mask,
        width,
        height,
        radius,
        featherPx: edgeFeatherPx,
      });
      reply(
        {
          ok: true,
          image: blended,
          width,
          height,
          method: "opencv",
          quality: "standard",
          requestId,
        },
        blended.buffer,
      );
      return;
    }

    // hasAnyMask already guarantees bounds resolve
    const bounds = computeMaskBounds(mask, width, height);
    let out = null;
    if (shouldUsePatchMatch({ image, mask, width, bounds, radius })) {
      out = patchMatchInpaintRGBA({ image, mask, width, height, radius, bounds });
    }
    // patchmatch bails out (null) on oversized or textureless regions
    if (!out) {
      out = harmonicInpaintRGBA({ image, mask, width, height, radius, bounds });
    }

    const blended = blendNaturalEdgesRGBA({
      original: image,
      inpainted: out,
      mask,
      width,
      height,
      radius,
      featherPx: edgeFeatherPx,
    });
    reply(
      { ok: true, image: blended, width, height, quality: "standard", requestId },
      blended.buffer,
    );
  } catch (err) {
    reply({
      ok: false,
      error: err instanceof Error ? err.message : "Unknown error",
      requestId,
    });
  }
});
