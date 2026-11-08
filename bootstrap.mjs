const API='https://amrs-api.akatsukiakira1102.workers.dev';
const PIN_HASH='ypXGN6eAKSKE5BTnyfouKeHxd+jkz5qAgy4csfOE8Zg=';
const PIN_SALT='JRM5b3kNYJd4Awi4yZg55g==';
const text=value=>String(value??'').trim();
function validBundle(value){
 return !!value&&typeof value.version==='string'&&typeof value.html==='string'&&value.html.length<2_000_000&&value.assets&&typeof value.assets==='object'&&Object.entries(value.assets).every(([name,body])=>/^[a-z0-9.-]+\.(js|css)$/i.test(name)&&typeof body==='string'&&body.length<2_000_000);
}
export async function loadProtectedClient(credential,{baseURL=API,fetchImpl=globalThis.fetch,cache,signal}={}){
 if(!text(credential))throw Error('請輸入 Token');
 let cached=null;try{cached=await cache?.read(credential);}catch{}
 if(!validBundle(cached))cached=null;
 try{
  const session=await fetchImpl(baseURL+'/session',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({token:credential}),signal});
  if(!session.ok)throw Object.assign(Error('驗證失敗 ('+session.status+')'),{status:session.status});
  const identity=await session.json();if(!text(identity.token))throw Object.assign(Error('驗證回應格式錯誤'),{status:502});
  const response=await fetchImpl(baseURL+'/client-shell'+(cached?'?version='+encodeURIComponent(cached.version):''),{headers:{authorization:'Bearer '+identity.token},cache:'no-store',signal});
  if(response.status===304&&cached)return cached;
  if(!response.ok)throw Object.assign(Error('介面載入失敗 ('+response.status+')'),{status:response.status});
  const result=await response.json();if(result.success!==true||!validBundle(result))throw Object.assign(Error('介面回應格式錯誤'),{status:502});
  const bundle={version:result.version,html:result.html,assets:result.assets};
  try{await cache?.write(credential,bundle);}catch{}
  return bundle;
 }catch(error){
  if(error.status===401||error.status===403){try{await cache?.remove(credential);}catch{}throw error;}
  if(!error.status&&error.name!=='AbortError'&&cached)return cached;
  throw error;
 }
}
export function readSavedCredential(storage){
 const personal=text(storage.getItem('_amrs_access_token_v1'));if(personal)return personal;
 const current=text(storage.getItem('_ml_company'));
 const direct=text(storage.getItem('_ml_gas_'+current)||storage.getItem('_ml_gas'));if(direct)return direct;
 for(let i=0;i<storage.length;i++){const key=storage.key(i);if(key?.startsWith('_ml_gas_')&&text(storage.getItem(key)))return text(storage.getItem(key));}
 return '';
}
export async function mountProtectedClient(bundle,documentRef=globalThis.document){
 if(!validBundle(bundle))throw Error('無效介面');
 const parsed=new DOMParser().parseFromString(bundle.html,'text/html');
 const scripts=[];
 for(const node of parsed.querySelectorAll('script')){
  const src=node.getAttribute('src');
  let code=node.textContent;
  if(src){const name=new URL(src,location.href).pathname.split('/').at(-1);if(!Object.hasOwn(bundle.assets,name))throw Error('介面缺少程式檔案');code=bundle.assets[name];}
  scripts.push(code);node.remove();
 }
 for(const link of parsed.querySelectorAll('link[rel="stylesheet"]')){
  const name=new URL(link.getAttribute('href'),location.href).pathname.split('/').at(-1);
  if(!Object.hasOwn(bundle.assets,name))throw Error('介面缺少樣式檔案');
  const style=parsed.createElement('style');style.textContent=bundle.assets[name];link.replaceWith(style);
 }
 // Only the authenticated, developer-owned interface is accepted here; record data is not HTML.
 documentRef.documentElement.className=parsed.documentElement.className;
 documentRef.head.replaceChildren(...[...parsed.head.childNodes].map(n=>documentRef.importNode(n,true)));
 documentRef.body.replaceWith(documentRef.importNode(parsed.body,true));
 for(const code of scripts){const script=documentRef.createElement('script');script.textContent=code;documentRef.body.append(script);}
}
async function browserCache(){
 const bucket=await caches.open('amrs-private-ui');
 const key=async credential=>{
  const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(credential));
  return new URL('./.private-ui/'+Array.from(new Uint8Array(digest),v=>v.toString(16).padStart(2,'0')).join(''),location.href).href;
 };
 return {read:async c=>{const r=await bucket.match(await key(c));return r?r.json():null;},write:async(c,b)=>bucket.put(await key(c),new Response(JSON.stringify(b),{headers:{'content-type':'application/json'}})),remove:async c=>bucket.delete(await key(c))};
}
async function start(){
 const $=id=>document.getElementById(id);
 let pin='',busy=false,mounted=false,tested='',candidate=null,cache;
 const abort=new AbortController();
 document.documentElement.classList.toggle('mob',/Android|iPhone|iPad|iPod|Mobile|webOS/i.test(navigator.userAgent)||screen.width<=768);
 try{cache=await browserCache();}catch{}
 function error(message){$('setupErr').textContent=message;}
 function showSetup(message=''){
  $('pinScreen').style.display='none';$('setupScreen').classList.add('show');
  $('gasUrlInput').value=readSavedCredential(localStorage);error(message);
  $('setupSaveBtn').disabled=true;
 }
 async function load(credential){
  $('bootStatus').hidden=false;$('bootStatus').textContent='正在驗證連線及使用權限…';
  try{const bundle=await loadProtectedClient(credential,{cache});mounted=true;abort.abort();await mountProtectedClient(bundle);}
  catch(e){mounted=false;showSetup(e.message||'未能連線，請稍後重試');}
  finally{if($('bootStatus'))$('bootStatus').hidden=true;}
 }
 function dots(){for(let i=0;i<6;i++)$('d'+i).classList.toggle('filled',i<pin.length);}
 function locked(){return Date.now()<Number(localStorage.getItem('_ml_pl')||0);}
 const lockMs=n=>n<=3?0:n===4?30000:n===5?300000:n===6?1800000:3600000;
 async function digit(value){
  if(busy||locked()||pin.length>=6)return;
  pin+=value;dots();if(pin.length!==6)return;
  busy=true;$('pinSub').textContent='驗證中…';
  try{
   const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(pin),'PBKDF2',false,['deriveBits']);
   const bits=await crypto.subtle.deriveBits({name:'PBKDF2',hash:'SHA-256',salt:Uint8Array.from(atob(PIN_SALT),c=>c.charCodeAt(0)),iterations:3000000},key,256);
   if(btoa(String.fromCharCode(...new Uint8Array(bits)))===PIN_HASH){
    localStorage.setItem('_ml_auth',PIN_HASH);localStorage.removeItem('_ml_pf');localStorage.removeItem('_ml_pl');
    const credential=readSavedCredential(localStorage);if(credential)await load(credential);else showSetup();
   }else{
    const fails=Number(localStorage.getItem('_ml_pf')||0)+1;localStorage.setItem('_ml_pf',String(fails));
    if(lockMs(fails))localStorage.setItem('_ml_pl',String(Date.now()+lockMs(fails)));
    $('pinError').style.opacity='1';$('pinSub').textContent=locked()?'嘗試次數過多，請稍後再試':'請輸入 PIN（錯誤 '+fails+' 次）';
   }
  }finally{pin='';busy=false;if($('d0'))dots();}
 }
 function back(){if(!busy&&!locked()){pin=pin.slice(0,-1);dots();}}
 document.querySelectorAll('[data-pin]').forEach(b=>b.addEventListener('click',()=>digit(b.dataset.pin)));
 $('pinBack').addEventListener('click',back);
 document.addEventListener('keydown',e=>{if($('pinScreen')?.style.display==='none')return;if(/^[0-9]$/.test(e.key))digit(e.key);else if(e.key==='Backspace')back();},{signal:abort.signal});
 function normalize(value){const raw=text(value);return /^amrs_[a-z0-9_-]{20,}$/i.test(raw)?raw:globalThis.AmrsAccessControl.extractDeployId(raw);}
 $('gasUrlInput').addEventListener('input',()=>{tested='';candidate=null;$('setupSaveBtn').disabled=true;$('setupTestResult').style.display='none';});
 $('setupTestBtn').addEventListener('click',async()=>{
  const value=normalize($('gasUrlInput').value);if(!value){error('請輸入有效個人 Token 或原有 Deploy ID');return;}
  $('setupTestBtn').disabled=true;error('');
  try{candidate=await loadProtectedClient(value,{cache});tested=value;$('setupTestResult').textContent='✓ 連接成功！';$('setupTestResult').className='ok';$('setupSaveBtn').disabled=false;}
  catch(e){candidate=null;tested='';$('setupSaveBtn').disabled=true;$('setupTestResult').textContent='✗ '+e.message;$('setupTestResult').className='err';}
  finally{$('setupTestBtn').disabled=false;$('setupTestResult').style.display='block';}
 });
 $('setupSaveBtn').addEventListener('click',async()=>{
  const value=normalize($('gasUrlInput').value);if(!tested||value!==tested||!candidate)return;
  const saved=globalThis.AmrsAccessControl.saveCredential(localStorage,value);
  if(saved.kind==='legacy')localStorage.setItem('_ml_gas',saved.value);
  mounted=true;abort.abort();await mountProtectedClient(candidate);
 });
 if('serviceWorker' in navigator){
  const hadController=!!navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener('controllerchange',()=>{if(hadController&&!mounted)location.reload();},{signal:abort.signal});
  navigator.serviceWorker.register('./sw.js',{updateViaCache:'none'}).then(r=>{r.waiting?.postMessage({type:'SKIP_WAITING'});r.update().catch(()=>{});r.addEventListener('updatefound',()=>{const w=r.installing;w?.addEventListener('statechange',()=>{if(w.state==='installed')r.waiting?.postMessage({type:'SKIP_WAITING'});});});}).catch(()=>{});
 }
 if(localStorage.getItem('_ml_auth')===PIN_HASH){const credential=readSavedCredential(localStorage);if(credential){$('pinScreen').style.display='none';await load(credential);}else showSetup();}
 else if(locked())$('pinSub').textContent='嘗試次數過多，請稍後再試';
}
if(typeof document!=='undefined')void start();
