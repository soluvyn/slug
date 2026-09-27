const MODEL_PATH = "/migan.onnx";

let ortSession = null;
let ortLib = null;
function loadOrt() {
  if (ortLib) return ortLib;
  try {
    importScripts("/vendor/ort.min.js");
    ort.env.wasm.wasmPaths = "/vendor/";
    ort.env.wasm.simd = true;
    // single-threaded on purpose: threads require cross-origin isolation, which
    // means COOP/COEP headers, which in turn block the font stylesheet
    ort.env.wasm.numThreads = 1;

    ortLib = ort;
  } catch (err) {
    console.error("[MI-GAN Worker] Failed to load ONNX:", err);
    throw err;
  }
  return ortLib;
}

// one cache only. serve.py sends max-age=0, so the http cache revalidates the
// model on every read and re-sends the 28MB on any miss. a second Cache
// Storage copy would have been duplication either way
async function loadModelFromFile(retries = 2) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const response = await fetch(MODEL_PATH);
      if (!response.ok) {
        throw new Error(`Failed to fetch model: ${response.status}`);
      }
      return new Uint8Array(await response.arrayBuffer());
    } catch (err) {
      if (attempt === retries) {
        console.error(
          `[MI-GAN Worker] Failed to load model after ${retries} attempts:`,
          err,
        );
        throw err;
      }
      console.warn(
        `[MI-GAN Worker] Model load attempt ${attempt} failed, retrying...`,
      );
      await new Promise((r) => setTimeout(r, 1000 * Math.pow(2, attempt - 1)));
    }
  }
}

async function getSession() {
  if (ortSession) return ortSession;
  const ort = loadOrt();
  const modelBuffer = await loadModelFromFile();
  if (!modelBuffer) throw new Error("MODEL_NOT_FOUND");

  ortSession = await ort.InferenceSession.create(modelBuffer, {
    executionProviders: ["wasm"],
    graphOptimizationLevel: "all",
  });
  return ortSession;
}

function clampByte(v) {
  if (v < 0) return 0;
  if (v > 255) return 255;
  return v;
}

function halfToFloat(h) {
  const s = (h & 0x8000) >> 15;
  const e = (h & 0x7c00) >> 10;
  const f = h & 0x03ff;
  if (e === 0) {
    if (f === 0) return s ? -0 : 0;
    return (s ? -1 : 1) * Math.pow(2, -14) * (f / 1024);
  }
  if (e === 31) {
    return f ? NaN : s ? -Infinity : Infinity;
  }
  return (s ? -1 : 1) * Math.pow(2, e - 15) * (1 + f / 1024);
}

function padToMultipleOf(image, mask, width, height, multiple) {
  const padW = (multiple - (width % multiple)) % multiple;
  const padH = (multiple - (height % multiple)) % multiple;
  if (padW === 0 && padH === 0)
    return { image, mask, width, height, padded: false };

  const newW = width + padW;
  const newH = height + padH;
  const outImage = new Uint8ClampedArray(newW * newH * 4);
  const outMask = new Uint8ClampedArray(newW * newH * 4);
  for (let y = 0; y < newH; y += 1) {
    const srcY = y < height ? y : height - 1;
    for (let x = 0; x < newW; x += 1) {
      const srcX = x < width ? x : width - 1;
      const srcI = (srcY * width + srcX) * 4;
      const dstI = (y * newW + x) * 4;
      outImage[dstI] = image[srcI];
      outImage[dstI + 1] = image[srcI + 1];
      outImage[dstI + 2] = image[srcI + 2];
      outImage[dstI + 3] = 255;
      outMask[dstI] = 0;
      outMask[dstI + 1] = 0;
      outMask[dstI + 2] = 0;
      outMask[dstI + 3] = mask[srcI + 3];
    }
  }

  return {
    image: outImage,
    mask: outMask,
    width: newW,
    height: newH,
    padded: true,
  };
}

function rgbaToCHWUint8(image, width, height) {
  const size = width * height;
  const out = new Uint8Array(3 * size);
  for (let i = 0, p = 0; p < size; p += 1, i += 4) {
    out[p] = image[i];
    out[size + p] = image[i + 1];
    out[size * 2 + p] = image[i + 2];
  }
  return out;
}

function rgbaAlphaToMaskUint8WithMode(mask, width, height, mode) {
  const size = width * height;
  const out = new Uint8Array(size);
  for (let i = 3, p = 0; p < size; p += 1, i += 4) {
    const a = mask[i];
    const painted = a >= 128;
    out[p] = mode === "hole0" ? (painted ? 0 : 255) : painted ? 255 : 0;
  }
  return out;
}

// stride the sample so a float16 tensor is never fully materialised just to
// find its range. toByte still converts per element during unpacking
function inferFloatMode(data, isHalf) {
  const len = data.length;
  const step = Math.max(1, Math.floor(len / 2048));
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < len; i += step) {
    const v = isHalf ? halfToFloat(data[i]) : data[i];
    if (v < min) min = v;
    if (v > max) max = v;
  }

  if (min >= -0.05 && max <= 1.25) return "0_1";
  if (min >= -1.25 && max <= 1.25) return "-1_1";
  return "0_255";
}

function cropRgba(image, width, height, targetW, targetH) {
  if (width === targetW && height === targetH) return image;
  const out = new Uint8ClampedArray(targetW * targetH * 4);
  for (let y = 0; y < targetH; y += 1) {
    const srcRow = y * width * 4;
    const dstRow = y * targetW * 4;
    out.set(image.subarray(srcRow, srcRow + targetW * 4), dstRow);
  }
  return out;
}

function looksLikeNoop({ original, out, mask, width, height }) {
  const totalPx = width * height;
  const step = Math.max(1, Math.floor(totalPx / 6000));
  let count = 0;
  let sum = 0;

  for (let p = 0; p < totalPx; p += step) {
    const i = p * 4;
    if (mask[i + 3] < 128) continue;
    const dr = Math.abs(out[i] - original[i]);
    const dg = Math.abs(out[i + 1] - original[i + 1]);
    const db = Math.abs(out[i + 2] - original[i + 2]);
    sum += dr + dg + db;
    count += 1;
    if (count >= 1200) break;
  }

  if (count === 0) return true;
  const mean = sum / (count * 3);
  return mean < 1.2;
}

function resizeRgbaBilinear(src, srcW, srcH, dstW, dstH) {
  if (srcW === dstW && srcH === dstH) return src;
  const dst = new Uint8ClampedArray(dstW * dstH * 4);
  const scaleX = srcW / dstW;
  const scaleY = srcH / dstH;

  for (let y = 0; y < dstH; y += 1) {
    const sy = (y + 0.5) * scaleY - 0.5;
    const y0 = Math.max(0, Math.min(srcH - 1, Math.floor(sy)));
    const y1 = Math.max(0, Math.min(srcH - 1, y0 + 1));
    const fy = sy - y0;

    for (let x = 0; x < dstW; x += 1) {
      const sx = (x + 0.5) * scaleX - 0.5;
      const x0 = Math.max(0, Math.min(srcW - 1, Math.floor(sx)));
      const x1 = Math.max(0, Math.min(srcW - 1, x0 + 1));
      const fx = sx - x0;

      const i00 = (y0 * srcW + x0) * 4;
      const i10 = (y0 * srcW + x1) * 4;
      const i01 = (y1 * srcW + x0) * 4;
      const i11 = (y1 * srcW + x1) * 4;

      const o = (y * dstW + x) * 4;
      for (let c = 0; c < 3; c += 1) {
        const v00 = src[i00 + c];
        const v10 = src[i10 + c];
        const v01 = src[i01 + c];
        const v11 = src[i11 + c];
        const top = v00 * (1 - fx) + v10 * fx;
        const bot = v01 * (1 - fx) + v11 * fx;
        dst[o + c] = clampByte(Math.round(top * (1 - fy) + bot * fy));
      }
      dst[o + 3] = 255;
    }
  }
  return dst;
}

function processNCHW(
  data,
  rgba,
  w,
  h,
  expectedW,
  expectedH,
  toByte,
) {
  const size = w * h;
  const o0 = 0;
  const o1 = size;
  const o2 = size * 2;
  const swapped = expectedW && expectedH && h === expectedW && w === expectedH;
  for (let p = 0, i = 0; p < size; p += 1, i += 4) {
    if (!swapped) {
      rgba[i] = toByte(data[o0 + p]);
      rgba[i + 1] = toByte(data[o1 + p]);
      rgba[i + 2] = toByte(data[o2 + p]);
    } else {
      const y = Math.floor(p / w);
      const x = p - y * w;
      const srcP = x * w + y;
      rgba[i] = toByte(data[o0 + srcP]);
      rgba[i + 1] = toByte(data[o1 + srcP]);
      rgba[i + 2] = toByte(data[o2 + srcP]);
    }
    rgba[i + 3] = 255;
  }
  return rgba;
}

function processNHWC(data, rgba, w, h, c, expectedW, expectedH, toByte) {
  const swapped = expectedW && expectedH && h === expectedW && w === expectedH;
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const src = swapped ? (x * w + y) * c : (y * w + x) * c;
      const dst = (y * w + x) * 4;
      rgba[dst] = toByte(data[src]);
      rgba[dst + 1] = toByte(data[src + 1]);
      rgba[dst + 2] = toByte(data[src + 2]);
      rgba[dst + 3] = 255;
    }
  }
  return rgba;
}

function tensorToRgba(outTensor, expectedW, expectedH) {
  const dims = outTensor.dims || [];
  const data = outTensor.data;
  const type = outTensor.type;

  if (!Array.isArray(dims) || dims.length !== 4) {
    throw new Error("Unsupported output dims");
  }

  const n = dims[0];
  if (n !== 1) throw new Error("Unsupported batch size");

  const isNCHW = dims[1] === 3 || dims[1] === 4;
  const isNHWC = dims[3] === 3 || dims[3] === 4;
  if (!isNCHW && !isNHWC) throw new Error("Unsupported output layout");

  const c = isNCHW ? dims[1] : dims[3];
  const h = isNCHW ? dims[2] : dims[1];
  const w = isNCHW ? dims[3] : dims[2];

  const isByteTensor =
    type === "uint8" &&
    data &&
    typeof data === "object" &&
    data.BYTES_PER_ELEMENT === 1;
  const isFloat16 = type === "float16" && data instanceof Uint16Array;
  const floatMode = isByteTensor
    ? null
    : inferFloatMode(data, isFloat16);

  const rgba = new Uint8ClampedArray(w * h * 4);

  function toByte(v) {
    if (isByteTensor) return v;
    if (isFloat16) v = halfToFloat(v);
    if (floatMode === "0_1") return clampByte(Math.round(v * 255));
    if (floatMode === "-1_1") return clampByte(Math.round((v + 1) * 0.5 * 255));
    return clampByte(Math.round(v));
  }

  const packed = isNCHW
    ? processNCHW(data, rgba, w, h, expectedW, expectedH, toByte)
    : processNHWC(data, rgba, w, h, c, expectedW, expectedH, toByte);

  return resizeRgbaBilinear(packed, w, h, expectedW || w, expectedH || h);
}

async function runInference(image, mask, width, height) {
  const ort = loadOrt();
  const session = await getSession();
  const padded = padToMultipleOf(image, mask, width, height, 8);
  const chw = rgbaToCHWUint8(padded.image, padded.width, padded.height);
  const imageTensor = new ort.Tensor("uint8", chw, [
    1,
    3,
    padded.height,
    padded.width,
  ]);

  const imageName = session.inputNames.includes("image")
    ? "image"
    : session.inputNames[0];
  const maskName = session.inputNames.includes("mask")
    ? "mask"
    : session.inputNames[1];
  const runWithMode = async (mode) => {
    const m = rgbaAlphaToMaskUint8WithMode(
      padded.mask,
      padded.width,
      padded.height,
      mode,
    );
    const maskTensor = new ort.Tensor("uint8", m, [
      1,
      1,
      padded.height,
      padded.width,
    ]);
    const results = await session.run({
      [imageName]: imageTensor,
      [maskName]: maskTensor,
    });
    // tensorToRgba already normalises to the padded size
    return tensorToRgba(
      results[session.outputNames[0]],
      padded.width,
      padded.height,
    );
  };

  const primary = await runWithMode("hole0");
  const noop = looksLikeNoop({
    original: padded.image,
    out: primary,
    mask: padded.mask,
    width: padded.width,
    height: padded.height,
  });
  if (!noop) return cropRgba(primary, padded.width, padded.height, width, height);
  // the model ignored the hole0 polarity, so retry with the mask inverted
  try {
    const alt = await runWithMode("hole255");
    return cropRgba(alt, padded.width, padded.height, width, height);
  } catch {
    return cropRgba(primary, padded.width, padded.height, width, height);
  }
}

self.addEventListener("message", async (event) => {
  const data = event.data;
  if (!data || typeof data.type !== "string") return;

  if (data.type === "check") {
    try {
      const response = await fetch(MODEL_PATH, { method: "HEAD" });
      self.postMessage({ type: "check", ready: response.ok });
    } catch {
      self.postMessage({ type: "check", ready: false });
    }
    return;
  }

  if (data.type !== "inpaint") return;

  try {
    const image = data.image;
    const mask = data.mask;
    const width = data.width;
    const height = data.height;
    if (!image || !mask || !width || !height) throw new Error("Invalid input");

    const out = await runInference(image, mask, width, height);
    self.postMessage({ type: "result", ok: true, image: out }, [out.buffer]);
  } catch (err) {
    self.postMessage({
      type: "result",
      ok: false,
      error: err instanceof Error ? err.message : "Unknown error",
    });
  }
});
