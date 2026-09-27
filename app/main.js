import { qs, qsa, lsGet, lsSet } from './utils.js';
import { createStore } from './state.js';
import { inpaintJob } from './inpaint.js';
import { Editor } from './editor.js';

const MODEL_URL='/migan.onnx';
const TOOL_KEYS={b:'brush',r:'rect',e:'ellipse'};

function initApp(){
  const editor=Editor();
  const store=createStore(editor);
  const fileInput=qs('#fileInput');
  const landing=qs('#landing');
  const canvasContainer=qs('#canvasContainer');
  const toolbarBottom=qs('#toolbarBottom');
  const spinner=qs('#spinner');
  const toastEl=qs('#toast');
  const toastText=qs('#toastText');
  const confirmOverlay=qs('#confirmOverlay');
  const confirmText=qs('#confirmText');
  const confirmOk=qs('#confirmOk');
  const confirmCancel=qs('#confirmCancel');
  const brushSlider=qs('#brushSlider');
  const brushDot=qs('#brushDot');
  const zoomLabel=qs('#zoomLabel');
  const undoBtn=qs('#undoBtn');
  const redoBtn=qs('#redoBtn');
  const clearBtn=qs('#clearBtn');
  const removeBtn=qs('#removeBtn');
  const downloadBtn=qs('.btn-download');
  const closeBtn=qs('#closeBtn');
  const toolButtons=qsa('[data-tool]');
  const modeButtons=qsa('.btn-mode');

  let prefetched=false;
  let syncQueued=false;
  let sourceName='';

  // exports are always PNG, so the name keeps the source stem for context but
  // the extension has to match the actual bytes: photo.jpg -> photo-std.png
  function exportName(source,quality){
    const n=source||'';
    const i=n.lastIndexOf('.');
    const stem=i>0?n.slice(0,i):n||'image';
    return stem+'-'+(quality==='pro'?'pro':'std')+'.png';
  }

  function setStatus(s){
    store.state.status=s;
    spinner.hidden=!(s==='loading'||s==='processing');
    syncUI();
  }

  function syncUI(){
    const hasMask=editor.ready&&editor.hasMask();
    const busy=store.isBusy();
    undoBtn.disabled=!store.canUndo()||busy;
    redoBtn.disabled=!store.canRedo()||busy;
    clearBtn.disabled=!hasMask||busy;
    removeBtn.disabled=!hasMask||busy;
    downloadBtn.disabled=!store.hasResult();
    closeBtn.disabled=!editor.ready;
    editor.setCursorVisible(editor.ready&&!busy);
    brushSlider.value=editor.brushSize;
    const d=Math.max(6,editor.brushSize/4);
    brushDot.style.width=d+'px';brushDot.style.height=d+'px';
  }

  // mask changes fire on every pointermove, so collapse them to one sync per frame
  function queueSyncUI(){
    if(syncQueued)return;
    syncQueued=true;
    requestAnimationFrame(()=>{syncQueued=false;syncUI()});
  }

  function setTool(tool){
    editor.tool=tool;
    toolButtons.forEach((b)=>b.classList.toggle('tool-active',b.dataset.tool===tool));
    syncUI();
  }

  function updateZoomLabel(){
    zoomLabel.textContent=Math.round(editor.zoom*100)+'%';
  }

  function setMode(next){
    store.state.mode=next;
    modeButtons.forEach((b)=>b.classList.toggle('active',b.dataset.mode===next));
    lsSet('proMode',next);
    // first switch to pro with only a standard result on screen: run it now
    if(next==='pro'&&editor.ready&&!store.state.proResult&&store.state.stdResult)doRemove('pro');
    syncUI();
  }

  async function doImport(file){
    if(store.hasResult()&&store.state.status==='ready'){
      const ok=await askConfirm('Unsaved changes will be lost. Import anyway?');
      if(!ok)return;
    }
    store.reset();
    sourceName=file.name||'';
    landing.hidden=true;
    canvasContainer.hidden=false;
    toolbarBottom.hidden=false;
    setStatus('loading');
    try{
      await editor.loadImage(file);
      setStatus('ready');
      editor.clearMask();
    }catch{
      setStatus('idle');
    }
  }

  function stepHistory(dir){
    if(!store[dir]())return;
    updateZoomLabel();
    syncUI();
  }

  async function doRemove(quality){
    if(!editor.ready||!editor.hasMask()||store.isBusy())return;
    store.pushUndo();
    setStatus('processing');
    const q=quality||store.state.mode;
    const radius=editor.brushSize/2;
    try{
      const result=await inpaintJob({
        imageData:editor.getImageData(),
        maskData:editor.getMaskData(),
        width:editor.width,
        height:editor.height,
        radius,
        feather:Math.max(2,Math.round(radius*0.3)),
        quality:q
      });
      if(!result.ok)throw new Error(result.error||'Inpainting failed');
      const data=new ImageData(new Uint8ClampedArray(result.image),result.width,result.height);
      editor.setImageData(data);
      editor.clearMask();
      store.commitResult(data,q);
      setStatus('ready');
    }catch(err){
      // never swallow this: a failed removal used to revert silently, which
      // looked exactly like the button doing nothing
      console.error('[remove] failed:',err);
      toast(err&&err.message?err.message:'Removal failed');
      setStatus('ready');
    }
  }

  let toastTimer=null;
  function toast(msg){
    toastText.textContent=msg;
    toastEl.hidden=false;
    clearTimeout(toastTimer);
    toastTimer=setTimeout(()=>{toastEl.hidden=true},6000);
  }

  // the promise is only settled from here, so the dialog must be dismissable:
  // focus in, tab trapped, escape cancels, focus back to the opener
  function askConfirm(msg){
    return new Promise((res)=>{
      const opener=document.activeElement;
      let done=false;
      function settle(v){
        if(done)return;
        done=true;
        confirmOverlay.hidden=true;
        document.removeEventListener('keydown',onKey,true);
        if(opener&&opener.focus)opener.focus();
        res(v);
      }
      function onKey(e){
        if(e.key==='Escape'){e.preventDefault();settle(false);return}
        if(e.key!=='Tab')return;
        // two buttons, so wrap between them instead of escaping the dialog
        const first=confirmCancel,last=confirmOk;
        if(e.shiftKey&&document.activeElement===first){e.preventDefault();last.focus()}
        else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first.focus()}
      }
      confirmText.textContent=msg;
      confirmOverlay.hidden=false;
      confirmOk.onclick=()=>settle(true);
      confirmCancel.onclick=()=>settle(false);
      document.addEventListener('keydown',onKey,true);
      confirmOk.focus();
    });
  }

  // releases the decoded image and returns to the drop-in stage
  function closeImage(){
    if(!editor.ready)return;
    store.reset();
    editor.unload();
    sourceName='';
    landing.hidden=false;
    canvasContainer.hidden=true;
    toolbarBottom.hidden=true;
    setStatus('idle');
  }

  function downloadResult(){
    const out=store.exportable();
    if(!out)return;
    const data=out.data;
    const name=exportName(sourceName,out.quality);
    const c=document.createElement('canvas');
    c.width=data.width;c.height=data.height;
    c.getContext('2d').putImageData(data,0,0);
    c.toBlob((blob)=>{
      const url=URL.createObjectURL(blob);
      const a=document.createElement('a');
      a.href=url;a.download=name;
      a.click();
      URL.revokeObjectURL(url);
    },'image/png');
  }

  // warms the http cache the migan worker later reads the 28MB model from
  function prefetchModel(){
    if(prefetched)return;
    prefetched=true;
    fetch(MODEL_URL).catch(()=>{});
  }

  // #landing spans the whole dotted stage (inset:0) so a click anywhere opens the
  // picker, and goes display:none on import, which stops it firing mid-draw
  landing.addEventListener('click',()=>fileInput.click());
  fileInput.addEventListener('change',()=>{
    if(fileInput.files&&fileInput.files[0]){doImport(fileInput.files[0]);fileInput.value=''}
  });

  document.addEventListener('dragover',(e)=>e.preventDefault());
  document.addEventListener('drop',(e)=>{
    e.preventDefault();
    const file=e.dataTransfer?.files?.[0];
    if(file&&file.type.startsWith('image/'))doImport(file);
  });

  undoBtn.addEventListener('click',()=>stepHistory('undo'));
  redoBtn.addEventListener('click',()=>stepHistory('redo'));
  clearBtn.addEventListener('click',()=>{if(editor.ready)editor.clearMask()});
  removeBtn.addEventListener('click',()=>doRemove());

  toolButtons.forEach((b)=>b.addEventListener('click',()=>setTool(b.dataset.tool)));
  modeButtons.forEach((b)=>b.addEventListener('click',()=>setMode(b.dataset.mode)));

  brushSlider.addEventListener('input',()=>{
    editor.brushSize=Number(brushSlider.value);
    syncUI();
  });
  brushSlider.addEventListener('change',()=>lsSet('brushSize',brushSlider.value));

  qs('#zoomOutBtn').addEventListener('click',()=>{editor.setZoom(editor.zoom/1.25);updateZoomLabel();syncUI()});
  qs('#zoomInBtn').addEventListener('click',()=>{editor.setZoom(editor.zoom*1.25);updateZoomLabel();syncUI()});
  zoomLabel.addEventListener('click',()=>{editor.setZoom(1);updateZoomLabel();syncUI()});

  document.addEventListener('keydown',(e)=>{
    // only text entry should swallow shortcuts; the range slider must not
    if(qs('input[type=text]:focus,input[type=number]:focus,input[type=search]:focus,textarea:focus'))return;
    const k=e.key.toLowerCase();
    if(e.ctrlKey||e.metaKey){
      if(k!=='z')return;
      e.preventDefault();
      stepHistory(e.shiftKey?'redo':'undo');
      return;
    }
    if(TOOL_KEYS[k])setTool(TOOL_KEYS[k]);
  });

  downloadBtn.addEventListener('click',downloadResult);
  closeBtn.addEventListener('click',closeImage);

  editor.onMaskChange(queueSyncUI);
  editor.onReady=()=>{syncUI()};

  document.addEventListener('pointerdown',prefetchModel,{once:true});
  document.addEventListener('keydown',prefetchModel,{once:true});

  const savedBrush=lsGet('brushSize',null);
  if(savedBrush!==null){editor.brushSize=Number(savedBrush);brushSlider.value=savedBrush}
  setMode(lsGet('proMode','standard')==='pro'?'pro':'standard');
}

document.addEventListener('DOMContentLoaded',initApp);
