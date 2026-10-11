// opencv telea, the standard path. fast, smooth, best on flat backgrounds

const VENDOR = new URL("../../vendor/", import.meta.url).href;

let cvPromise = null;

function loadCv() {
  cvPromise ??= import(VENDOR + "opencv.js")
    .then((mod) => mod.init(VENDOR))
    .catch((err) => {
      cvPromise = null;
      throw err;
    });
  return cvPromise;
}

export async function teleaInpaint(image, hole, width, height, radius) {
  const cv = await loadCv();
  const mats = [];
  const mat = (m) => (mats.push(m), m);
  try {
    const rgba = mat(new cv.Mat(height, width, cv.CV_8UC4));
    rgba.data.set(image);
    const rgb = mat(new cv.Mat());
    cv.cvtColor(rgba, rgb, cv.COLOR_RGBA2RGB);
    // .data is a getter that builds a fresh view, so it is set in one go
    const mask = mat(new cv.Mat(height, width, cv.CV_8UC1));
    mask.data.set(hole);
    const out = mat(new cv.Mat());
    cv.inpaint(rgb, mask, out, radius, cv.INPAINT_TELEA);
    cv.cvtColor(out, rgba, cv.COLOR_RGB2RGBA);
    return new Uint8ClampedArray(rgba.data);
  } finally {
    for (const m of mats) m.delete();
  }
}
