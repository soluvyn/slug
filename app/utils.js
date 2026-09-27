export function qs(s){return document.querySelector(s)}
export function qsa(s){return document.querySelectorAll(s)}
export function lsGet(k,def){try{const v=localStorage.getItem(k);return v!==null?v:def}catch{return def}}
export function lsSet(k,v){try{localStorage.setItem(k,String(v))}catch{}}
