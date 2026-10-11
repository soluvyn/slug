// mi-gan inference. a classic worker of its own: ort.min.js is a classic
// script, and a hung or crashed session can be dropped by terminating it

const MODEL_URL = new URL("../migan.onnx", self.location.href).href;
const VENDOR = new URL("../vendor/", self.location.href).href;

let session = null;

function getSession() {
  session ??= (async () => {
    if (!self.ort) importScripts(VENDOR + "ort.min.js");
    ort.env.wasm.wasmPaths = VENDOR;
    // threads need cross-origin isolation, which serve.py's COOP/COEP headers
    // give. about half the logical cores: past 6 a run got no faster
    ort.env.wasm.numThreads = self.crossOriginIsolated
      ? Math.min(6, Math.ceil((navigator.hardwareConcurrency || 2) / 2))
      : 1;
    const res = await fetch(MODEL_URL);
    if (!res.ok) throw new Error(`MI-GAN model unavailable (HTTP ${res.status})`);
    return ort.InferenceSession.create(new Uint8Array(await res.arrayBuffer()), {
      executionProviders: ["wasm"],
      graphOptimizationLevel: "all",
    });
  })().catch((err) => {
    session = null;
    throw err;
  });
  return session;
}

// migan.onnx is the full pipeline: uint8 image [1,3,h,w] and mask [1,1,h,w]
// (255 keep, 0 fill) at any size in, uint8 result [1,3,h,w] out
async function inpaint(image, hole, width, height) {
  const s = await getSession();
  const n = width * height;
  const chw = new Uint8Array(n * 3);
  const keep = new Uint8Array(n);
  for (let p = 0, i = 0; p < n; p += 1, i += 4) {
    chw[p] = image[i];
    chw[p + n] = image[i + 1];
    chw[p + 2 * n] = image[i + 2];
    keep[p] = hole[p] ? 0 : 255;
  }
  const { result } = await s.run({
    image: new ort.Tensor("uint8", chw, [1, 3, height, width]),
    mask: new ort.Tensor("uint8", keep, [1, 1, height, width]),
  });
  const out = new Uint8ClampedArray(n * 4);
  for (let p = 0, i = 0; p < n; p += 1, i += 4) {
    out[i] = result.data[p];
    out[i + 1] = result.data[p + n];
    out[i + 2] = result.data[p + 2 * n];
    out[i + 3] = 255;
  }
  return out;
}

self.onmessage = async ({ data }) => {
  try {
    const image =
      data.type === "load"
        ? (await getSession(), null)
        : await inpaint(data.image, data.hole, data.width, data.height);
    self.postMessage({ id: data.id, ok: true, image }, image ? [image.buffer] : []);
  } catch (err) {
    self.postMessage({ id: data.id, ok: false, error: err?.message || String(err) });
  }
};
