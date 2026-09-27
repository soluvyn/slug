import { qs } from './utils.js';

export function Editor(){
  const imgCanvas=qs('#imageCanvas');
  const maskCanvas=qs('#maskCanvas');
  const prevCanvas=qs('#previewCanvas');
  const shapeCanvas=qs('#shapeCanvas');
  const cursor=qs('#brushCursor');
  const scroll=qs('#canvasScroll');

  let img=null,imgW=0,imgH=0,zoom=1,displayW=0,displayH=0;
  let tool='brush',brushSize=24;
  let isDrawing=false,origin=null;
  let ready=false,readyCb=null;
  let maskDirty=false;
  let rectCache=null;

  const ictx=imgCanvas.getContext('2d',{willReadFrequently:true});
  const mctx=maskCanvas.getContext('2d',{willReadFrequently:true});
  const pctx=prevCanvas.getContext('2d',{willReadFrequently:true});
  const sctx=shapeCanvas.getContext('2d',{willReadFrequently:true});

  let maskChangeCb=null;
  function onMaskChange(fn){maskChangeCb=fn}
  function notifyMaskChange(){if(maskChangeCb)maskChangeCb()}

  function syncCanvases(){
    [maskCanvas,prevCanvas,shapeCanvas,imgCanvas].forEach((c)=>{c.width=imgW;c.height=imgH});
    if(ready&&img){
      ictx.clearRect(0,0,imgW,imgH);
      ictx.drawImage(img,0,0);
    }
    mctx.clearRect(0,0,imgW,imgH);
    pctx.clearRect(0,0,imgW,imgH);
    sctx.clearRect(0,0,imgW,imgH);
    maskDirty=false;
    layout();
  }

  function layout(){
    const parent=scroll.parentElement;
    if(!ready||parent.hidden)return;
    const rect=parent.getBoundingClientRect();
    const pad=40;
    const availW=rect.width-pad*2;
    const availH=rect.height-pad*2;
    if(availW<=0||availH<=0)return;
    const fit=Math.min(availW/imgW,availH/imgH,1);
    const scale=fit*zoom;
    displayW=Math.floor(imgW*scale);
    displayH=Math.floor(imgH*scale);
    invalidateRect();
    [imgCanvas,maskCanvas,prevCanvas,shapeCanvas].forEach((c)=>{
      c.style.width=displayW+'px';
      c.style.height=displayH+'px';
    });
    const cs=brushSize*scale;
    cursor.style.width=cs+'px';
    cursor.style.height=cs+'px';
    notifyMaskChange();
  }

  function setZoom(z){
    zoom=Math.min(5,Math.max(0.1,z));
    layout();
  }

  function loadImage(file){
    return new Promise((res,rej)=>{
      const reader=new FileReader();
      reader.onload=(e)=>{
        const i=new Image();
        i.onload=()=>{initBitmap(i);res()};
        i.onerror=()=>rej(new Error('decode failed'));
        i.src=e.target.result;
      };
      reader.onerror=()=>rej(new Error('read failed'));
      reader.readAsDataURL(file);
    });
  }
  function initBitmap(i){
    img=i;imgW=i.naturalWidth||i.width;imgH=i.naturalHeight||i.height;
    zoom=1;ready=true;
    syncCanvases();
    if(readyCb)readyCb();
  }

  // drops the decoded bitmap and zeroes the backing stores, so closing an image
  // actually releases the memory rather than just hiding it
  function unload(){
    img=null;imgW=0;imgH=0;zoom=1;displayW=0;displayH=0;
    isDrawing=false;origin=null;maskDirty=false;ready=false;
    [maskCanvas,prevCanvas,shapeCanvas,imgCanvas].forEach((c)=>{c.width=0;c.height=0});
    cursor.style.display='none';
    invalidateRect();
    notifyMaskChange();
  }

  function getImageData(){return ictx.getImageData(0,0,imgW,imgH)}
  function getMaskData(){return mctx.getImageData(0,0,imgW,imgH)}
  function setImageData(data){ictx.putImageData(data,0,0)}
  function clearMask(){
    mctx.clearRect(0,0,imgW,imgH);
    clearMaskPreview();
    maskDirty=false;
    notifyMaskChange();
  }

  // tracked incrementally: getImageData here allocated a full w*h*4 copy on
  // every syncUI, which syncUI runs on every pointermove
  function hasMask(){
    return maskDirty;
  }

  // a rect read mid-gesture forces a sync layout, and reading between style
  // writes is what stuttered the cursor. only scroll and layout() move it
  function invalidateRect(){rectCache=null}
  function getCanvasRect(){
    if(!rectCache)rectCache=maskCanvas.getBoundingClientRect();
    return rectCache;
  }
  function toCanvasPos(clientX,clientY){
    const r=getCanvasRect();
    return{
      x:(clientX-r.left)*(imgW/r.width),
      y:(clientY-r.top)*(imgH/r.height)
    };
  }
  function getCanvasPos(e){return toCanvasPos(e.clientX,e.clientY)}

  let lastBrushX=0,lastBrushY=0;
  let maskPattern=null;
  let maskPatternKey='';
  function maskColors(){
    const cs=getComputedStyle(document.documentElement);
    const read=(name,fallback)=>(cs.getPropertyValue(name).trim()||fallback);
    return{
      base:read('--mask-base','rgb(255 255 255 / .22)'),
      line:read('--primary','#54a2ff'),
      shade:read('--mask-shade','rgb(10 34 80 / .85)')
    };
  }
  function getMaskPattern(){
    const c3=maskColors();
    // keyed on the resolved colours so a theme change rebuilds instead of
    // serving a pattern baked from the previous palette
    const key=c3.base+'|'+c3.line+'|'+c3.shade;
    if(maskPattern&&maskPatternKey===key)return maskPattern;
    maskPatternKey=key;
    // step must divide the tile size or the diagonals show a seam every N pixels
    const s=16,step=8;
    const c=document.createElement('canvas');
    c.width=c.height=s;
    const ctx=c.getContext('2d');
    ctx.fillStyle=c3.base;
    ctx.fillRect(0,0,s,s);
    ctx.lineCap='butt';
    // one direction only, drawn three times: a wide dark stroke, a narrow
    // bright core on top, and both again mirrored. the core always has the
    // stroke under it, so it reads on a bright photo as well as a dark one
    const draw=(width,style,dir)=>{
      ctx.lineWidth=width;
      ctx.strokeStyle=style;
      ctx.beginPath();
      for(let i=-s;i<=s*2;i+=step){
        ctx.moveTo(i,0);
        ctx.lineTo(i+dir*s,s);
      }
      ctx.stroke();
    };
    draw(4,c3.shade,1);
    draw(1.5,c3.line,1);
    draw(4,c3.shade,-1);
    draw(1.5,c3.line,-1);
    maskPattern=ctx.createPattern(c,'repeat');
    return maskPattern;
  }

  function renderMaskPreview(){
    pctx.clearRect(0,0,imgW,imgH);
    pctx.fillStyle=getMaskPattern();
    pctx.fillRect(0,0,imgW,imgH);
    pctx.globalCompositeOperation='destination-in';
    pctx.drawImage(maskCanvas,0,0);
    pctx.globalCompositeOperation='source-over';
  }

  // a click must always mark the mask, so the dot is filled explicitly rather
  // than relying on a zero-length round-capped line, which is not dependable
  function dab(x,y,s){
    mctx.beginPath();
    mctx.arc(x,y,s/2,0,Math.PI*2);
    mctx.fillStyle='white';
    mctx.fill();
    maskDirty=true;
    notifyMaskChange();
    renderMaskPreview();
  }

  function drawBrush(x,y,s){
    mctx.lineWidth=s;
    mctx.lineCap='round';
    mctx.lineJoin='round';
    mctx.strokeStyle='white';
    mctx.lineTo(x,y);
    mctx.stroke();
    maskDirty=true;
    notifyMaskChange();
    renderMaskPreview();
  }

  function startShape(p){
    origin=p;
    sctx.clearRect(0,0,imgW,imgH);
    // matches the mask it is about to become
    sctx.strokeStyle='rgba(84,162,255,0.95)';
    sctx.fillStyle='rgba(84,162,255,0.16)';
    sctx.setLineDash([6,4]);
    sctx.lineWidth=2;
  }

  function updateShape(p){
    sctx.clearRect(0,0,imgW,imgH);
    if(!origin)return;
    const x0=Math.min(origin.x,p.x),y0=Math.min(origin.y,p.y);
    const w=Math.abs(p.x-origin.x),h=Math.abs(p.y-origin.y);
    if(tool==='rect'){
      sctx.fillRect(x0,y0,w,h);
      sctx.strokeRect(x0,y0,w,h);
    }else if(tool==='ellipse'){
      sctx.beginPath();
      sctx.ellipse(x0+w/2,y0+h/2,w/2,h/2,0,0,Math.PI*2);
      sctx.fill();
      sctx.stroke();
    }
  }

  function finalizeShape(p){
    sctx.clearRect(0,0,imgW,imgH);
    sctx.setLineDash([]);
    if(!origin)return;
    const x0=Math.min(origin.x,p.x),y0=Math.min(origin.y,p.y);
    const w=Math.abs(p.x-origin.x),h=Math.abs(p.y-origin.y);
    mctx.fillStyle='white';
    if(tool==='rect'){mctx.fillRect(x0,y0,w,h)}
    else if(tool==='ellipse'){
      mctx.beginPath();
      mctx.ellipse(x0+w/2,y0+h/2,w/2,h/2,0,0,Math.PI*2);
      mctx.fill();
    }
    origin=null;
    maskDirty=true;
    notifyMaskChange();
    renderMaskPreview();
  }

  function clearMaskPreview(){
    pctx.clearRect(0,0,imgW,imgH);
  }

  maskCanvas.addEventListener('pointerdown',(e)=>{
    if(!ready)return;
    e.preventDefault();
    invalidateRect();
    isDrawing=true;
    maskCanvas.setPointerCapture(e.pointerId);
    const p=getCanvasPos(e);
    lastBrushX=p.x;lastBrushY=p.y;
    if(tool==='brush'){dab(p.x,p.y,brushSize)}
    else{
      mctx.beginPath();
      mctx.moveTo(p.x,p.y);
      startShape(p);
    }
  });

  // pointermove fires at the mouse polling rate (>100Hz), so keep the newest
  // sample and apply it once per frame. strokes join lastBrush -> current
  let sampleX=0,sampleY=0,moveQueued=false;
  function flushPointer(){
    moveQueued=false;
    const r=getCanvasRect();
    const ox=sampleX-r.left,oy=sampleY-r.top;
    cursor.style.transform='translate3d('+ox+'px,'+oy+'px,0) translate(-50%,-50%)';
    if(!isDrawing)return;
    const p={x:ox*(imgW/r.width),y:oy*(imgH/r.height)};
    if(tool==='brush'){
      mctx.beginPath();
      mctx.moveTo(lastBrushX,lastBrushY);
      drawBrush(p.x,p.y,brushSize);
      lastBrushX=p.x;lastBrushY=p.y;
    }else{
      updateShape(p);
    }
  }

  maskCanvas.addEventListener('pointermove',(e)=>{
    if(!ready)return;
    sampleX=e.clientX;sampleY=e.clientY;
    if(moveQueued)return;
    moveQueued=true;
    requestAnimationFrame(flushPointer);
  });

  maskCanvas.addEventListener('pointerup',(e)=>{
    if(!isDrawing)return;
    isDrawing=false;
    if(tool!=='brush'){finalizeShape(getCanvasPos(e))}
    try{maskCanvas.releasePointerCapture(e.pointerId)}catch{}
  });

  maskCanvas.addEventListener('pointercancel',()=>{
    if(isDrawing){
      isDrawing=false;
      sctx.clearRect(0,0,imgW,imgH);
      sctx.setLineDash([]);
      origin=null;
    }
  });

  scroll.addEventListener('scroll',invalidateRect);

  window.addEventListener('pointerup',(e)=>{
    if(!isDrawing)return;
    isDrawing=false;
    if(tool!=='brush'&&origin)finalizeShape(getCanvasPos(e));
  });

  window.addEventListener('blur',()=>{
    if(isDrawing){
      isDrawing=false;
      sctx.clearRect(0,0,imgW,imgH);
      sctx.setLineDash([]);
      origin=null;
    }
  });

  const ro=new ResizeObserver(()=>layout());
  ro.observe(scroll.parentElement);

  return{
    loadImage,unload,setZoom,
    get zoom(){return zoom},
    getImageData,getMaskData,setImageData,
    clearMask,hasMask,
    set brushSize(v){
      brushSize=v;
      layout();
    },
    get brushSize(){return brushSize},
    set tool(v){tool=v},
    get tool(){return tool},
    get width(){return imgW},
    get height(){return imgH},
    get ready(){return ready},
    set onReady(v){readyCb=v},
    setCursorVisible(v){
      const show=v&&tool==='brush';
      cursor.style.display=show?'block':'none';
      maskCanvas.style.cursor=show?'none':'crosshair';
    },
    onMaskChange
  };
}
