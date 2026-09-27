// undo history, cached results, mode and busy status. takes the editor as a
// port so it runs against a stub. undo entries hold {data,zoom} only, so
// undoing clears the result and redoing brings it back

// a snapshot is a full getImageData copy, so 10 of a 24MP photo is ~1GB and
// will OOM the tab. cap by bytes too, evict oldest first
const MAX_ENTRIES = 10;
const MAX_HISTORY_BYTES = 256 * 1024 * 1024;

export function createStore(editor) {
  const state = {
    status: "idle",
    mode: "standard",
    stdResult: null,
    proResult: null,
  };
  let undoStack = [];
  let redoStack = [];

  const isBusy = () => state.status === "processing";
  const hasResult = () => !!(state.stdResult || state.proResult);
  const canUndo = () => undoStack.length > 0;
  const canRedo = () => redoStack.length > 0;

  function snapshot() {
    const data = editor.getImageData();
    return { data, zoom: editor.zoom, bytes: data.data.length };
  }

  function historyBytes() {
    let n = 0;
    for (const e of undoStack) n += e.bytes || 0;
    for (const e of redoStack) n += e.bytes || 0;
    return n;
  }

  function trimHistory() {
    while (undoStack.length > 1 && (undoStack.length > MAX_ENTRIES || historyBytes() > MAX_HISTORY_BYTES)) {
      undoStack.shift();
    }
    while (redoStack.length && historyBytes() > MAX_HISTORY_BYTES) {
      redoStack.pop();
    }
  }

  function apply(entry) {
    editor.setImageData(entry.data);
    editor.setZoom(entry.zoom);
    editor.clearMask();
    state.stdResult = entry.std || null;
    state.proResult = entry.pro || null;
  }

  function reset() {
    undoStack = [];
    redoStack = [];
    state.stdResult = null;
    state.proResult = null;
  }

  function pushUndo() {
    if (!editor.ready) return;
    undoStack.push(snapshot());
    redoStack = [];
    trimHistory();
  }

  // one restore for both directions: undo entries carry no std/pro, so
  // popping one lands in the same cleared state an explicit discard would
  function step(from, to) {
    if (from.length === 0 || isBusy()) return false;
    to.push({ ...snapshot(), std: state.stdResult, pro: state.proResult });
    apply(from.pop());
    trimHistory();
    return true;
  }

  return {
    state,
    isBusy,
    hasResult,
    canUndo,
    canRedo,
    reset,
    pushUndo,
    undo: () => step(undoStack, redoStack),
    redo: () => step(redoStack, undoStack),
    commitResult(data, quality) {
      if (quality === "pro") state.proResult = data;
      else state.stdResult = data;
    },
    /** what an export would write: the pixels plus the pass that produced
     *  them, so the caller can suffix the filename to match */
    exportable() {
      if (state.proResult) return { data: state.proResult, quality: "pro" };
      if (state.stdResult) return { data: state.stdResult, quality: "standard" };
      return null;
    },
  };
}
