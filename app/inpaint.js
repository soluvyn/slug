// client for workers/inpaint.mjs. replies are matched to jobs by id

let worker = null;
let nextId = 0;
const pending = new Map();

function getWorker() {
  if (worker) return worker;
  worker = new Worker(new URL("../workers/inpaint.mjs", import.meta.url), { type: "module" });
  worker.onmessage = ({ data }) => {
    const job = pending.get(data.id);
    if (!job) return;
    pending.delete(data.id);
    if (data.ok) job.resolve(data.patch);
    else job.reject(new Error(data.error || "Inpainting failed"));
  };
  // a dead worker would leave every caller hanging: fail them all, and let the
  // next job spawn a fresh one
  worker.onerror = (e) => {
    for (const job of pending.values()) job.reject(new Error(e.message || "Inpaint worker failed"));
    pending.clear();
    worker.terminate();
    worker = null;
  };
  return worker;
}

// image and mask are full-size ImageData, transferred, so they are unusable
// afterwards. resolves to the changed patch {x, y, width, height, data}, or
// null for an empty mask
export function inpaint({ image, mask, radius, quality }) {
  return new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, { resolve, reject });
    getWorker().postMessage(
      { id, image: image.data, mask: mask.data, width: image.width, height: image.height, radius, quality },
      [image.data.buffer, mask.data.buffer],
    );
  });
}

// starts the mi-gan download and session setup ahead of the first pro job
export function warmUpPro() {
  getWorker().postMessage({ type: "warmup" });
}
