// the canvas stack: the image, the hatch the user sees over the mask, the
// shape being dragged, and the mask itself, which is invisible and takes the
// pointer input. coordinates are image pixels unless they say otherwise

const $ = (id) => document.getElementById(id);
const MIN_ZOOM = 0.1;
const MAX_ZOOM = 5;

export function createEditor({ onChange }) {
  const scroll = $("canvasScroll");
  const imageCanvas = $("imageCanvas");
  const previewCanvas = $("previewCanvas");
  const shapeCanvas = $("shapeCanvas");
  const maskCanvas = $("maskCanvas");
  const cursor = $("brushCursor");
  const canvases = [imageCanvas, previewCanvas, shapeCanvas, maskCanvas];

  // read back for every removal and undo patch: cpu backing keeps that cheap,
  // and a gpu round trip is not guaranteed to be lossless
  const ictx = imageCanvas.getContext("2d", { willReadFrequently: true });
  const pctx = previewCanvas.getContext("2d");
  const sctx = shapeCanvas.getContext("2d");
  const mctx = maskCanvas.getContext("2d");

  let width = 0;
  let height = 0;
  let zoom = 1;
  let scale = 1; // css px per image px
  let tool = "brush";
  let brushSize = 24;
  let hasMask = false;
  let gesture = null; // {id, x, y, ox, oy}: pointer, last point, shape origin
  let sample = null; // newest pointer position not yet drawn
  let colors = null;

  function load(img) {
    width = img.naturalWidth;
    height = img.naturalHeight;
    for (const c of canvases) {
      c.width = width; // also clears it
      c.height = height;
    }
    ictx.drawImage(img, 0, 0);
    zoom = 1;
    hasMask = false;
    gesture = null;
    layout();
  }

  // zeroes the backing stores, so closing actually releases the memory
  function unload() {
    width = height = 0;
    hasMask = false;
    gesture = null;
    for (const c of canvases) c.width = c.height = 0;
  }

  function layout() {
    if (!width) return;
    const r = scroll.getBoundingClientRect();
    const cs = getComputedStyle(scroll);
    const availW = r.width - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
    const availH = r.height - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
    if (availW <= 0 || availH <= 0) return;
    scale = Math.min(availW / width, availH / height, 1) * zoom;
    const w = Math.max(1, Math.floor(width * scale)) + "px";
    const h = Math.max(1, Math.floor(height * scale)) + "px";
    for (const c of canvases) {
      c.style.width = w;
      c.style.height = h;
    }
    cursor.style.width = cursor.style.height = brushSize * scale + "px";
  }

  // keeps whatever is in the middle of the view there
  function setZoom(z) {
    if (!width) return;
    const cx = (scroll.scrollLeft + scroll.clientWidth / 2) / scroll.scrollWidth;
    const cy = (scroll.scrollTop + scroll.clientHeight / 2) / scroll.scrollHeight;
    zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));
    layout();
    scroll.scrollLeft = cx * scroll.scrollWidth - scroll.clientWidth / 2;
    scroll.scrollTop = cy * scroll.scrollHeight - scroll.clientHeight / 2;
  }

  // the mask colours come from color.css, read once on first use
  function style() {
    if (colors) return colors;
    const css = getComputedStyle(document.documentElement);
    const v = (name) => css.getPropertyValue(name).trim();
    const accent = v("--primary");
    // the line spacing (8) has to divide the tile, or the diagonals show a seam
    const tile = document.createElement("canvas");
    tile.width = tile.height = 16;
    const t = tile.getContext("2d");
    t.fillStyle = v("--mask-base");
    t.fillRect(0, 0, 16, 16);
    // a wide dark stroke under a narrow bright one, both ways, so the hatch
    // reads on a bright photo as well as a dark one
    for (const dir of [1, -1]) {
      for (const [lineWidth, color] of [[4, v("--mask-shade")], [1.5, accent]]) {
        t.lineWidth = lineWidth;
        t.strokeStyle = color;
        t.beginPath();
        for (let i = -16; i <= 32; i += 8) {
          t.moveTo(i, 0);
          t.lineTo(i + dir * 16, 16);
        }
        t.stroke();
      }
    }
    return (colors = { accent, hatch: pctx.createPattern(tile, "repeat") });
  }

  // repaints the hatch over the mask within a rect. destination-in also
  // clears everything it covers outside the mask, so the clip is load-bearing
  function marked(x, y, w, h) {
    const x0 = Math.max(0, Math.floor(x) - 2), y0 = Math.max(0, Math.floor(y) - 2);
    const x1 = Math.min(width, Math.ceil(x + w) + 2), y1 = Math.min(height, Math.ceil(y + h) + 2);
    hasMask = true;
    onChange();
    if (x1 <= x0 || y1 <= y0) return;
    const rw = x1 - x0, rh = y1 - y0;
    pctx.save();
    pctx.beginPath();
    pctx.rect(x0, y0, rw, rh);
    pctx.clip();
    pctx.clearRect(x0, y0, rw, rh);
    pctx.fillStyle = style().hatch;
    pctx.fillRect(x0, y0, rw, rh);
    pctx.globalCompositeOperation = "destination-in";
    pctx.drawImage(maskCanvas, x0, y0, rw, rh, x0, y0, rw, rh);
    pctx.restore();
  }

  function stroke(x0, y0, x1, y1) {
    mctx.fillStyle = mctx.strokeStyle = "#fff";
    mctx.lineWidth = brushSize;
    mctx.lineCap = "round";
    mctx.beginPath();
    // a zero-length line is pruned rather than capped, so a click is a filled dot
    if (x0 === x1 && y0 === y1) {
      mctx.arc(x0, y0, brushSize / 2, 0, Math.PI * 2);
      mctx.fill();
    } else {
      mctx.moveTo(x0, y0);
      mctx.lineTo(x1, y1);
      mctx.stroke();
    }
    const r = brushSize / 2;
    marked(Math.min(x0, x1) - r, Math.min(y0, y1) - r, Math.abs(x1 - x0) + brushSize, Math.abs(y1 - y0) + brushSize);
  }

  function shapePath(ctx, p) {
    const x = Math.min(gesture.ox, p.x), y = Math.min(gesture.oy, p.y);
    const w = Math.abs(p.x - gesture.ox), h = Math.abs(p.y - gesture.oy);
    ctx.beginPath();
    if (tool === "rect") ctx.rect(x, y, w, h);
    else ctx.ellipse(x + w / 2, y + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
    return { x, y, w, h };
  }

  function previewShape(p) {
    const { accent } = style();
    sctx.clearRect(0, 0, width, height);
    shapePath(sctx, p);
    sctx.fillStyle = sctx.strokeStyle = accent;
    sctx.globalAlpha = 0.16;
    sctx.fill();
    // line and dashes in css px, so they look the same at any zoom
    sctx.globalAlpha = 0.95;
    sctx.lineWidth = 2 / scale;
    sctx.setLineDash([6 / scale, 4 / scale]);
    sctx.stroke();
    sctx.globalAlpha = 1;
  }

  function commitShape(p) {
    sctx.clearRect(0, 0, width, height);
    const { x, y, w, h } = shapePath(mctx, p);
    // a click with a shape tool selects nothing
    if (w < 1 || h < 1) return;
    mctx.fillStyle = "#fff";
    mctx.fill();
    marked(x, y, w, h);
  }

  function toImage(e) {
    const r = maskCanvas.getBoundingClientRect();
    const ox = e.clientX - r.left, oy = e.clientY - r.top;
    return { ox, oy, x: (ox * width) / r.width, y: (oy * height) / r.height };
  }

  // pointermove outpaces the display, so only the newest sample is drawn,
  // once a frame, as a segment on from the last one
  function flush() {
    if (!sample) return;
    const p = toImage(sample);
    sample = null;
    cursor.style.transform = `translate(${p.ox}px, ${p.oy}px) translate(-50%, -50%)`;
    if (!gesture) return;
    if (tool === "brush") {
      stroke(gesture.x, gesture.y, p.x, p.y);
      gesture.x = p.x;
      gesture.y = p.y;
    } else {
      previewShape(p);
    }
  }

  function end(e, commit) {
    if (!gesture || e.pointerId !== gesture.id) return;
    // draw up to the release point, which a pending frame would otherwise drop
    sample = e;
    flush();
    if (tool !== "brush") {
      if (commit) commitShape(toImage(e));
      else sctx.clearRect(0, 0, width, height);
    }
    gesture = null;
  }

  maskCanvas.addEventListener("pointerdown", (e) => {
    if (!width || gesture || e.button !== 0) return;
    e.preventDefault();
    maskCanvas.setPointerCapture(e.pointerId);
    const p = toImage(e);
    gesture = { id: e.pointerId, x: p.x, y: p.y, ox: p.x, oy: p.y };
    if (tool === "brush") stroke(p.x, p.y, p.x, p.y);
  });
  maskCanvas.addEventListener("pointermove", (e) => {
    if (!width || (gesture && e.pointerId !== gesture.id)) return;
    if (!sample) requestAnimationFrame(flush);
    sample = { clientX: e.clientX, clientY: e.clientY };
  });
  maskCanvas.addEventListener("pointerup", (e) => end(e, true));
  maskCanvas.addEventListener("pointercancel", (e) => end(e, false));
  maskCanvas.addEventListener("lostpointercapture", (e) => end(e, false));
  new ResizeObserver(layout).observe(scroll);

  return {
    load,
    unload,
    setZoom,
    get ready() {
      return width > 0;
    },
    get zoom() {
      return zoom;
    },
    get hasMask() {
      return hasMask;
    },
    get tool() {
      return tool;
    },
    set tool(v) {
      tool = v;
    },
    get brushSize() {
      return brushSize;
    },
    set brushSize(v) {
      brushSize = v;
      cursor.style.width = cursor.style.height = brushSize * scale + "px";
    },
    clearMask() {
      mctx.clearRect(0, 0, width, height);
      pctx.clearRect(0, 0, width, height);
      hasMask = false;
      onChange();
    },
    setCursorVisible(v) {
      const show = v && tool === "brush";
      cursor.hidden = !show;
      maskCanvas.style.cursor = show ? "none" : "crosshair";
    },
    imageData: () => ictx.getImageData(0, 0, width, height),
    maskData: () => mctx.getImageData(0, 0, width, height),
    read: (x, y, w, h) => ictx.getImageData(x, y, w, h),
    write: (data, x, y) => ictx.putImageData(data, x, y),
    toBlob: () => new Promise((resolve) => imageCanvas.toBlob(resolve, "image/png")),
  };
}
