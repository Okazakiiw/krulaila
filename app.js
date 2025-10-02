// ======= Config & Keys =======
const STORAGE_KEY = 're_meta_v8i';
const DB_NAME = 're_db_v8i';
const STORE = 'images';

// ======= DOM Utils =======
const byId = (id)=>document.getElementById(id);
const qs = (sel, el=document)=>el.querySelector(sel);
const qsa = (sel, el=document)=>Array.from(el.querySelectorAll(sel));

// ======= Local Storage (metadata) =======
function load(){
  try{ return JSON.parse(localStorage.getItem(STORAGE_KEY)||'[]'); }catch{ return []; }
}
function save(items){
  localStorage.setItem(STORAGE_KEY, JSON.stringify(items||[]));
  window.dispatchEvent(new Event('re:updated'));
}
function nextId(items){
  const used = new Set(items.map(x=>Number(x.id)||0));
  let id = items.length ? Math.max(...Array.from(used))+1 : 1;
  while(used.has(id)) id++;
  return id;
}

// ======= IndexedDB (images) =======
let _dbPromise;
function db(){
  if(_dbPromise) return _dbPromise;
  _dbPromise = new Promise((resolve, reject)=>{
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = (ev)=>{
      const db = ev.target.result;
      if(!db.objectStoreNames.contains(STORE)){
        db.createObjectStore(STORE);
      }
    };
    req.onsuccess = ()=>resolve(req.result);
    req.onerror = ()=>reject(req.error);
  });
  return _dbPromise;
}
async function idbPut(key, blob){
  const d = await db();
  return new Promise((resolve,reject)=>{
    const tx = d.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(blob, key);
    tx.oncomplete = ()=>resolve(true);
    tx.onerror = ()=>reject(tx.error);
  });
}
async function idbGet(key){
  const d = await db();
  return new Promise((resolve,reject)=>{
    const tx = d.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).get(key);
    req.onsuccess = ()=>resolve(req.result||null);
    req.onerror = ()=>reject(req.error);
  });
}

// ======= Helpers =======
function dataURLToBlob(dataURL){
  const [meta, data] = String(dataURL).split(',');
  const isBase64 = /;base64$/i.test(meta);
  const mime = (meta.match(/data:([^;]+)/)||[])[1] || 'application/octet-stream';
  const bytes = isBase64 ? atob(data) : decodeURIComponent(data);
  const buf = new Uint8Array(bytes.length);
  for(let i=0;i<bytes.length;i++) buf[i]=bytes.charCodeAt(i);
  return new Blob([buf], {type:mime});
}
function readFileAsDataURL(file){
  return new Promise((resolve,reject)=>{
    const fr = new FileReader();
    fr.onload = ()=>resolve(fr.result);
    fr.onerror = ()=>reject(fr.error);
    fr.readAsDataURL(file);
  });
}
function normalize(arr){
  return (arr||[]).map(x=>({
    id: Number(x.id)||0,
    title: String(x.title||'').trim(),
    desc: String(x.desc||'').trim(),
    price: Number(x.price)||0,
    imageKey: String(x.imageKey||'').trim()
  }));
}

// ======= Bootstrap from remote JSON =======
async function bootstrapFromRemote(force=false){
  try{
    if (!force && localStorage.getItem(STORAGE_KEY)) return;
    const resp = await fetch('./data/listings-with-images.json', { cache: 'no-store' });
    if(!resp.ok) return;
    const raw = await resp.json();
    const items = Array.isArray(raw) ? normalize(raw) : normalize(raw.items||[]);
    const images = Array.isArray(raw) ? null : (raw.images||null);

    if (images && typeof images === 'object'){
      for (const [key, dataURL] of Object.entries(images)){
        if (!key || !dataURL) continue;
        try { await idbPut(key, dataURLToBlob(String(dataURL))); } catch {}
      }
    }

    // fix duplicate/empty ids
    const used = new Set();
    const fixed = items.map((x, i)=>{
      let id = Number(x.id)|| (i+1);
      while(used.has(id) || id<=0) id++;
      used.add(id);
      return {...x, id};
    });

    save(fixed);
    console.log('[bootstrap] imported from remote JSON.');
  }catch(e){
    console.warn('[bootstrap] failed:', e);
  }
}

// ======= Render (Index) =======
async function renderIndex(){
  const root = byId('list');
  if(!root) return;
  const q = (byId('q')?.value||'').toLowerCase();
  const minP = Number(byId('minPrice')?.value||0);
  const maxP = Number(byId('maxPrice')?.value||0);
  const sort = byId('sort')?.value||'new';

  let items = load();
  items = items.filter(x=>{
    const okQ = !q || (x.title.toLowerCase().includes(q) || x.desc.toLowerCase().includes(q));
    const okMin = !minP || x.price>=minP;
    const okMax = !maxP || x.price<=maxP;
    return okQ && okMin && okMax;
  });
  if(sort==='new') items.sort((a,b)=>b.id-a.id);
  if(sort==='old') items.sort((a,b)=>a.id-b.id);
  if(sort==='priceAsc') items.sort((a,b)=>a.price-b.price);
  if(sort==='priceDesc') items.sort((a,b)=>b.price-a.price);

  byId('metaCount').textContent = `ทั้งหมด ${items.length} รายการ`;

  root.innerHTML='';
  for(const it of items){
    const card = document.createElement('article');
    card.className='card';
    const img = document.createElement('img');
    img.className='media';
    img.alt = it.title||'';
    // load image blob from idb
    try{
      if(it.imageKey){
        const blob = await idbGet(it.imageKey);
        if(blob) img.src = URL.createObjectURL(blob);
      }
    }catch{}
    if(!img.src) img.alt = '(ไม่มีรูป)';

    const body = document.createElement('div');
    body.className='pad';
    body.innerHTML = `
      <h3>${escapeHtml(it.title)}</h3>
      <p class="muted">${escapeHtml(it.desc||'')}</p>
      <div class="row gap">
        <span class="badge">฿ ${Number(it.price).toLocaleString()}</span>
        <span class="badge muted">#${it.id}</span>
      </div>
    `;
    card.append(img, body);
    root.append(card);
  }
}
function escapeHtml(s){
  return String(s).replace(/[&<>"']/g, m=>({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[m]));
}

// ======= Admin Page =======
async function renderAdmin(){
  const root = byId('adminList');
  if(!root) return;
  const items = load().sort((a,b)=>b.id-a.id);
  root.innerHTML='';
  for(const it of items){
    const row = document.createElement('div');
    row.className='item-row';
    const thumb = document.createElement('img');
    try{
      if(it.imageKey){
        const blob = await idbGet(it.imageKey);
        if(blob) thumb.src = URL.createObjectURL(blob);
      }
    }catch{}
    if(!thumb.src) thumb.alt='(no image)';
    const meta = document.createElement('div');
    meta.className='col';
    meta.innerHTML=`<strong>${escapeHtml(it.title)}</strong><small class="muted">฿ ${Number(it.price).toLocaleString()} • #${it.id}</small>`;
    const actions = document.createElement('div');
    actions.className='row gap';
    const btnEdit = document.createElement('button');
    btnEdit.className='btn outline'; btnEdit.textContent='แก้ไข';
    btnEdit.onclick = ()=>fillForm(it);
    const btnDel = document.createElement('button');
    btnDel.className='btn danger'; btnDel.textContent='ลบ';
    btnDel.onclick = ()=>{
      if(!confirm('ยืนยันลบรายการนี้?')) return;
      const arr = load().filter(x=>x.id!==it.id);
      save(arr); renderAdmin();
    };
    actions.append(btnEdit, btnDel);
    row.append(thumb, meta, actions);
    root.append(row);
  }
}
function fillForm(it){
  byId('f_id').value = it.id;
  byId('f_title').value = it.title||'';
  byId('f_desc').value = it.desc||'';
  byId('f_price').value = it.price||0;
  // รูปให้แนบใหม่ถ้าต้องการเปลี่ยน
  window.scrollTo({top:0, behavior:'smooth'});
}

// ======= Export / Import =======
async function exportAll(){
  const items = load();
  const images = {};
  for (const it of items){
    if(!it.imageKey) continue;
    try{
      const blob = await idbGet(it.imageKey);
      if(blob){
        const dataURL = await new Promise((resolve)=>{
          const fr = new FileReader();
          fr.onload = ()=>resolve(fr.result);
          fr.readAsDataURL(blob);
        });
        images[it.imageKey] = dataURL;
      }
    }catch{}
  }
  const payload = { items, images, exportedAt: new Date().toISOString() };
  const blob = new Blob([JSON.stringify(payload,null,2)], {type:'application/json'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = 'listings-with-images.json';
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(()=>URL.revokeObjectURL(url), 1000);
}
async function importAll(file){
  const text = await file.text();
  const json = JSON.parse(text||'{}');
  const items = Array.isArray(json)? normalize(json) : normalize(json.items||[]);
  const images = Array.isArray(json)? null : (json.images||null);

  if(images && typeof images==='object'){
    for(const [key, dataURL] of Object.entries(images)){
      try{ await idbPut(key, dataURLToBlob(String(dataURL))); }catch{}
    }
  }
  // merge: overwrite by id
  const current = load();
  const map = new Map(current.map(x=>[x.id,x]));
  for(const it of items){ map.set(Number(it.id)||0, it); }
  save(Array.from(map.values()));
}

// ======= Wire-up =======
window.addEventListener('DOMContentLoaded', async ()=>{
  // Index
  if(byId('list')){
    await bootstrapFromRemote(false);
    await renderIndex();
    byId('btnApply')?.addEventListener('click', renderIndex);
    byId('btnRefresh')?.addEventListener('click', async ()=>{
      await bootstrapFromRemote(true);
      await renderIndex();
    });
    ['q','minPrice','maxPrice','sort'].forEach(id=>byId(id)?.addEventListener('change', ()=>renderIndex()));
    window.addEventListener('re:updated', renderIndex);
  }

  // Admin
  if(byId('adminList')){
    await renderAdmin();
    window.addEventListener('re:updated', renderAdmin);
    byId('btnExport')?.addEventListener('click', exportAll);
    byId('fileImport')?.addEventListener('change', (e)=>{
      const f = e.target.files?.[0]; if(f) importAll(f);
      e.target.value='';
    });
    byId('btnClear')?.addEventListener('click', ()=>{
      if(!confirm('ล้างข้อมูลทั้งหมดในเครื่องนี้?')) return;
      localStorage.removeItem(STORAGE_KEY);
      const req = indexedDB.deleteDatabase(DB_NAME);
      req.onsuccess = ()=>location.reload();
      req.onerror = ()=>location.reload();
    });
    // form submit
    const form = byId('formItem');
    form?.addEventListener('submit', async (e)=>{
      e.preventDefault();
      const idRaw = Number(byId('f_id').value||0);
      const title = byId('f_title').value.trim();
      const desc = byId('f_desc').value.trim();
      const price = Number(byId('f_price').value||0);
      const file = byId('f_image').files?.[0] || null;

      let items = load();
      let id = idRaw>0 ? idRaw : nextId(items);
      let imageKey = null;

      if(file){
        imageKey = `img_${Date.now()}_${Math.random().toString(36).slice(2,7)}`;
        const dataURL = await readFileAsDataURL(file);
        await idbPut(imageKey, dataURLToBlob(dataURL));
      }else if(idRaw>0){
        // keep existing imageKey if editing without new file
        const found = items.find(x=>x.id===idRaw);
        if(found) imageKey = found.imageKey||null;
      }

      const newItem = { id, title, desc, price, imageKey };
      const exists = items.some(x=>x.id===id);
      if(exists) items = items.map(x=>x.id===id ? newItem : x);
      else items.push(newItem);
      save(items);
      (e.target).reset();
      byId('f_id').value='';
      alert('บันทึกแล้ว');
    });
  }
});
