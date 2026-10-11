// undo/redo of applied removals. an entry holds only the patch a removal
// changed, before and after, so stepping is one putImageData either way

// a full-frame patch of a 24MP photo is ~190MB with both copies, so the cap
// is by bytes, oldest evicted first
const MAX_BYTES = 256 * 1024 * 1024;

const size = (entry) => entry.before.data.length * 2;

export function createHistory() {
  let undo = [];
  let redo = [];
  let bytes = 0;
  // quality of the newest evicted entry: undoing everything that is left
  // still leaves an edited image
  let base = null;

  return {
    get canUndo() {
      return undo.length > 0;
    },
    get canRedo() {
      return redo.length > 0;
    },
    // the pass behind what is on screen, or null while it is the original
    get quality() {
      return undo.at(-1)?.quality ?? base;
    },
    clear() {
      undo = [];
      redo = [];
      bytes = 0;
      base = null;
    },
    // entry: {x, y, before, after, quality}, before/after being ImageData
    push(entry) {
      for (const e of redo) bytes -= size(e);
      redo = [];
      undo.push(entry);
      bytes += size(entry);
      while (bytes > MAX_BYTES && undo.length > 1) {
        const old = undo.shift();
        bytes -= size(old);
        base = old.quality;
      }
    },
    undo() {
      const e = undo.pop();
      if (e) redo.push(e);
      return e;
    },
    redo() {
      const e = redo.pop();
      if (e) undo.push(e);
      return e;
    },
  };
}
