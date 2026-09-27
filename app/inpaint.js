const WORKER_URL='/workers/inpaint.mjs';
const MAX_EDGE=2048;

let worker=null;
let reqId=0;
const pending=new Map();

function getWorker(){
  if(worker)return worker;
  worker=new Worker(WORKER_URL,{type:'module'});
  worker.onmessage=(e)=>{
    const d=e.data;
    if(!d||d.requestId==null)return;
    const done=pending.get(d.requestId);
    if(!done)return;
    pending.delete(d.requestId);
    done(d);
  };
  // a dead worker would otherwise leave every caller hanging, and would keep
  // being reused: drop the reference so the next job respawns it
  worker.onerror=(e)=>{
    const err={ok:false,error:e.message||'inpaint worker failed'};
    pending.forEach((done)=>done(err));
    pending.clear();
    worker=null;
  };
  return worker;
}

// bilinear resample, returning the input untouched when the size already
// matches, so callers must copy before transferring
function resample(pixels,fromW,fromH,toW,toH){
  if(fromW===toW&&fromH===toH)return pixels;
  const src=document.createElement('canvas');
  src.width=fromW;src.height=fromH;
  src.getContext('2d').putImageData(new ImageData(pixels,fromW,fromH),0,0);
  const dst=document.createElement('canvas');
  dst.width=toW;dst.height=toH;
  const dctx=dst.getContext('2d');
  dctx.imageSmoothingQuality='high';
  dctx.drawImage(src,0,0,toW,toH);
  return dctx.getImageData(0,0,toW,toH).data;
}

export function inpaintJob(params){
  const{imageData,maskData,width,height,radius,feather,quality}=params;
  const scale=Math.min(1,MAX_EDGE/width,MAX_EDGE/height);
  const workW=Math.round(width*scale);
  const workH=Math.round(height*scale);

  let image=resample(imageData.data,width,height,workW,workH);
  let mask=resample(maskData.data,width,height,workW,workH);
  // these buffers get transferred, so they must never alias the editor's own
  if(image===imageData.data)image=image.slice();
  if(mask===maskData.data)mask=mask.slice();

  return new Promise((res)=>{
    const id=++reqId;
    pending.set(id,(d)=>{
      if(!d||!d.ok||!d.image){
        res({ok:false,error:(d&&d.error)||'inpaint failed'});
        return;
      }
      res({
        ok:true,
        image:resample(d.image,d.width,d.height,width,height),
        width,
        height
      });
    });
    getWorker().postMessage({
      type:'inpaint',
      requestId:id,
      image,
      mask,
      width:workW,
      height:workH,
      radius:Math.round(radius),
      edgeFeatherPx:feather,
      quality
    },[image.buffer,mask.buffer]);
  });
}
