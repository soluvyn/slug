// opencv telea inpainting. fast on flat low-texture backgrounds, so it is
// tried first on the standard path

let cvReadyPromise;



async function getCv() {
  if (!cvReadyPromise) {
    cvReadyPromise = import("/vendor/opencv.js").then((mod) =>
      mod.init("/vendor/"),
    );
  }
  const cv = await cvReadyPromise;
  if (!cv) throw new Error("OpenCV init failed");
  return cv;
}

export async function tryOpenCvInpaint({ image, mask, width, height, radius }) {
  try {
    const cv = await getCv();
    if (!cv || typeof cv.inpaint !== "function") return null;

    const srcRgba = cv.matFromImageData(new ImageData(image, width, height));
    const rgb = new cv.Mat();
    cv.cvtColor(srcRgba, rgb, cv.COLOR_RGBA2RGB);
    srcRgba.delete();

    const maskMat = new cv.Mat(height, width, cv.CV_8UC1);
    for (let i = 0, p = 0; i < mask.length; i += 4, p += 1) {
      maskMat.data[p] = mask[i + 3] > 0 ? 255 : 0;
    }

    const dstRgb = new cv.Mat();
    cv.inpaint(rgb, maskMat, dstRgb, radius, cv.INPAINT_TELEA);
    rgb.delete();

    const dstRgba = new cv.Mat();
    cv.cvtColor(dstRgb, dstRgba, cv.COLOR_RGB2RGBA);
    dstRgb.delete();

    const out = new Uint8ClampedArray(dstRgba.data);

    maskMat.delete();
    dstRgba.delete();

    return out;
  } catch {
    return null;
  }
}
