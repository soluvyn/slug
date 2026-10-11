import { createEditor } from "./editor.js";
import { createHistory } from "./history.js";
import { inpaint, warmUpPro } from "./inpaint.js";

const $ = (id) => document.getElementById(id);
const TOOL_KEYS = { b: "brush", r: "rect", e: "ellipse" };

const landing = $("landing");
const fileInput = $("fileInput");
const canvasScroll = $("canvasScroll");
const toolbar = $("toolbarBottom");
const spinner = $("spinner");
const toastEl = $("toast");
const toastText = $("toastText");
const dialog = $("confirmDialog");
const confirmText = $("confirmText");
const brushSlider = $("brushSlider");
const brushDot = $("brushDot");
const zoomLabel = $("zoomLabel");
const undoBtn = $("undoBtn");
const redoBtn = $("redoBtn");
const clearBtn = $("clearBtn");
const removeBtn = $("removeBtn");
const downloadBtn = $("downloadBtn");
const closeBtn = $("closeBtn");
const toolButtons = document.querySelectorAll("[data-tool]");
const modeButtons = document.querySelectorAll("[data-mode]");

const history = createHistory();
const editor = createEditor({ onChange: sync });

let mode = "standard";
let busy = false; // decoding an import or running a removal
let job = 0; // bumped by import and close, so a late result is dropped
let sourceName = "";
let toastTimer = 0;

// storage throws in some private modes; the preferences are optional
function lsGet(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function lsSet(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {}
}

function sync() {
  const masked = editor.hasMask && !busy;
  undoBtn.disabled = busy || !history.canUndo;
  redoBtn.disabled = busy || !history.canRedo;
  clearBtn.disabled = removeBtn.disabled = !masked;
  downloadBtn.disabled = busy || history.quality === null;
  closeBtn.disabled = !editor.ready;
  spinner.hidden = !busy;
  editor.setCursorVisible(editor.ready && !busy);
  zoomLabel.textContent = Math.round(editor.zoom * 100) + "%";
  brushDot.style.width = brushDot.style.height = Math.max(6, editor.brushSize / 4) + "px";
  for (const b of toolButtons) {
    b.classList.toggle("tool-active", b.dataset.tool === editor.tool);
    b.setAttribute("aria-pressed", b.dataset.tool === editor.tool);
  }
  for (const b of modeButtons) {
    b.classList.toggle("active", b.dataset.mode === mode);
    b.setAttribute("aria-pressed", b.dataset.mode === mode);
  }
}

function setBusy(v) {
  busy = v;
  sync();
}

function showStage(hasImage) {
  landing.hidden = hasImage;
  canvasScroll.hidden = !hasImage;
  toolbar.hidden = !hasImage;
}

function toast(msg) {
  toastText.textContent = msg;
  toastEl.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (toastEl.hidden = true), 6000);
}

// the native modal handles focus, the tab trap and escape
function askConfirm(msg) {
  confirmText.textContent = msg;
  dialog.returnValue = "";
  dialog.showModal();
  return new Promise((resolve) => {
    dialog.addEventListener("close", () => resolve(dialog.returnValue === "ok"), { once: true });
  });
}

const confirmDiscard = (action) =>
  history.quality === null || askConfirm(`Unsaved changes will be lost. ${action} anyway?`);

// decoded before anything is torn down, so a bad file leaves the current image alone
async function decode(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    if (!img.naturalWidth || !img.naturalHeight) throw new Error("no size");
    return img;
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function openFile(file) {
  if (dialog.open || !(await confirmDiscard("Import"))) return;
  const token = ++job;
  setBusy(true);
  try {
    const img = await decode(file);
    if (token !== job) return;
    history.clear();
    sourceName = file.name;
    showStage(true);
    editor.load(img);
    if (mode === "pro") warmUpPro();
  } catch {
    if (token === job) toast(`Couldn't open ${file.name || "that file"} as an image`);
  } finally {
    if (token === job) setBusy(false);
  }
}

async function closeImage() {
  if (!editor.ready || !(await confirmDiscard("Close"))) return;
  job++;
  history.clear();
  editor.unload();
  sourceName = "";
  showStage(false);
  setBusy(false);
}

async function remove() {
  if (busy || !editor.hasMask) return;
  const token = job;
  const quality = mode;
  setBusy(true);
  try {
    const patch = await inpaint({
      image: editor.imageData(),
      mask: editor.maskData(),
      radius: editor.brushSize / 2,
      quality,
    });
    if (token !== job) return;
    if (patch) {
      const { x, y, width, height } = patch;
      const after = new ImageData(patch.data, width, height);
      history.push({ x, y, before: editor.read(x, y, width, height), after, quality });
      editor.write(after, x, y);
    }
    editor.clearMask();
  } catch (err) {
    if (token !== job) return;
    // a failure that only reverted looked exactly like the button doing nothing
    console.error("[remove] failed:", err);
    toast(err.message || "Removal failed");
  } finally {
    if (token === job) setBusy(false);
  }
}

function step(dir) {
  if (busy) return;
  const e = dir === "undo" ? history.undo() : history.redo();
  if (!e) return;
  editor.write(dir === "undo" ? e.before : e.after, e.x, e.y);
  sync();
}

// always png, so photo.jpg exports as photo-std.png
async function download() {
  const blob = await editor.toBlob();
  if (!blob) return toast("Couldn't export the image");
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `${sourceName.replace(/\.[^.]*$/, "") || "image"}-${history.quality === "pro" ? "pro" : "std"}.png`;
  a.click();
  // revoking in the same task can cancel the download in some browsers
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
}

function setMode(next) {
  mode = next;
  lsSet("proMode", next);
  if (mode === "pro" && editor.ready) warmUpPro();
  sync();
}

function setTool(tool) {
  editor.tool = tool;
  sync();
}

function zoomTo(z) {
  editor.setZoom(z);
  sync();
}

// #landing covers the whole stage, so a click anywhere on it opens the picker
landing.addEventListener("click", () => fileInput.click());
fileInput.addEventListener("change", () => {
  const file = fileInput.files[0];
  fileInput.value = ""; // so picking the same file again still fires
  if (file) openFile(file);
});
document.addEventListener("dragover", (e) => e.preventDefault());
document.addEventListener("drop", (e) => {
  e.preventDefault();
  const file = e.dataTransfer?.files[0];
  if (file) openFile(file);
});

undoBtn.addEventListener("click", () => step("undo"));
redoBtn.addEventListener("click", () => step("redo"));
clearBtn.addEventListener("click", () => editor.clearMask());
removeBtn.addEventListener("click", remove);
downloadBtn.addEventListener("click", download);
closeBtn.addEventListener("click", closeImage);
for (const b of toolButtons) b.addEventListener("click", () => setTool(b.dataset.tool));
for (const b of modeButtons) b.addEventListener("click", () => setMode(b.dataset.mode));
$("zoomOutBtn").addEventListener("click", () => zoomTo(editor.zoom / 1.25));
$("zoomInBtn").addEventListener("click", () => zoomTo(editor.zoom * 1.25));
zoomLabel.addEventListener("click", () => zoomTo(1));

brushSlider.addEventListener("input", () => {
  editor.brushSize = Number(brushSlider.value);
  sync();
});
brushSlider.addEventListener("change", () => lsSet("brushSize", brushSlider.value));

document.addEventListener("keydown", (e) => {
  if (dialog.open || e.altKey) return;
  const k = e.key.toLowerCase();
  if (e.ctrlKey || e.metaKey) {
    if (k !== "z") return;
    e.preventDefault();
    step(e.shiftKey ? "redo" : "undo");
  } else if (TOOL_KEYS[k]) {
    setTool(TOOL_KEYS[k]);
  }
});

const savedBrush = Number(lsGet("brushSize"));
if (savedBrush >= Number(brushSlider.min) && savedBrush <= Number(brushSlider.max)) {
  editor.brushSize = savedBrush;
}
brushSlider.value = editor.brushSize;
setMode(lsGet("proMode") === "pro" ? "pro" : "standard");
