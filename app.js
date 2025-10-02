// app.js (v8i+img - overlay detail + gallery main contain + lightbox)

window.addEventListener('DOMContentLoaded', () => {

  /* ============== Lightbox helpers (ภาพเต็มจอ) ============== */
  function openLightbox(src){
    const lb = document.getElementById('lightbox');
    const im = document.getElementById('lightboxImg');
    if(!lb || !im) return;
    im.src = src || '';
    lb.style.display = 'flex';
  }
  function closeLightbox(){
    const lb = document.getElementById('lightbox');
    if(lb) lb.style.display = 'none';
  }
  document.getElementById('lightbox')?.addEventListener('click', closeLightbox);
  document.addEventListener('keydown', e => { if(e.key==='Escape') closeLightbox(); });

  /* ===================== Keys & Constants ===================== */
  const STORAGE_KEY = 're_meta_v8i';        // เก็บ meta listings ใน localStorage
  const PASS_KEY    = 're_admin_pass';      // รหัสผ่านแอดมิน
  const DEFAULT_PASS = 'admin123';

  const TYPES_KEY   = 're_types_v1';        // ประเภท
  const DEFAULT_TYPES = ['บ้าน','ที่ดิน'];

  // IndexedDB สำหรับเก็บรูป (บีบอัดแล้ว)
  const DB_NAME = 're_db_v8i';
  const STORE   = 'imgStore';

  // legacy keys (ย้ายข้อมูลเก่าเข้ามา ถ้ายังมี)
  const LEGACY = ['re_meta_v8h','re_listings_v8g','re_listings_v8f','re_listings_v8e','re_listings_v8d','re_listings_v8c','re_listings_v8b'];

  /* ===================== DOM Helpers ===================== */
  const byId = s => document.getElementById(s);
  const setYear = () => { const y = byId('year'); if (y) y.textContent = new Date().getFullYear(); };

  /* ===================== Utils ===================== */
  const coerceId = n => Number(n) || 0;
  const nextId = a => a.reduce((m,x)=>Math.max(m,coerceId(x.id)),0) + 1;
  const pFloat = v => { const x = parseFloat(v); return Number.isNaN(x) ? '' : x; };
  const baht = n => (n!=null && n!=='') ? Number(n).toLocaleString() + ' บาท' : '-';
  const mapLink = (lat,lng)=> `https://www.google.com/maps?q=${lat},${lng}`;

  // Google Maps URL → lat,lng
  function parseGmapLink(url){
    try{
      const s = decodeURIComponent((url||'').trim());
      const at = s.match(/@(-?\d+(\.\d+)?),\s*(-?\d+(\.\d+)?)/);
      if(at) return {lat:+at[1], lng:+at[3]};
      const q = s.match(/[?&]q=([-0-9.,\s]+)/);
      if(q){ const p = q[1].split(',').map(x=>+x.trim()); if(p.length>=2) return {lat:p[0], lng:p[1]}; }
      const simple = s.match(/(-?\d+(\.\d+)?),\s*(-?\d+(\.\d+)?)/);
      if(simple) return {lat:+simple[1], lng:+simple[3]};
    }catch{}
    return null;
  }

  // แปลง DataURL <-> Blob (ใช้ตอน export/import images)
  function dataURLToBlob(dataURL){
    const arr = String(dataURL).split(',');
    const mime = (arr[0].match(/:(.*?);/)||[])[1] || 'image/jpeg';
    const bstr = atob(arr[1] || '');
    let n = bstr.length;
    const u8 = new Uint8Array(n);
    while(n--) u8[n] = bstr.charCodeAt(n);
    return new Blob([u8], {type:mime});
  }
  function blobToDataURL(blob){
    return new Promise((resolve,reject)=>{
      const fr = new FileReader();
      fr.onload = ()=> resolve(fr.result);
      fr.onerror = reject;
      fr.readAsDataURL(blob);
    });
  }

  /* ===================== Types store ===================== */
  const loadTypes = ()=> {
    try{
      const a = JSON.parse(localStorage.getItem(TYPES_KEY)||'[]');
      const arr = Array.isArray(a) && a.length ? a : DEFAULT_TYPES.slice();
      return [...new Set(arr.map(s=>String(s||'').trim()).filter(Boolean))];
    }catch{ return DEFAULT_TYPES.slice(); }
  };
  const saveTypes = (arr)=>{
    const clean = [...new Set((arr||[]).map(s=>String(s||'').trim()).filter(Boolean))];
    localStorage.setItem(TYPES_KEY, JSON.stringify(clean.length?clean:DEFAULT_TYPES));
  };
  function renderTypeOptions(selectEls){
    const types = loadTypes();
    (selectEls||[]).forEach(sel=>{
      if(!sel) return;
      const keep = sel.value;
      sel.innerHTML = types.map(t=>`<option value="${t}">${t}</option>`).join('');
      if(keep && types.includes(keep)) sel.value = keep;
    });
  }

  /* ===================== LocalStorage (meta) ===================== */
  (function migrateLegacy(){
    try{
      if(!localStorage.getItem(STORAGE_KEY)){
        for(const k of LEGACY){
          const v = localStorage.getItem(k);
          if(v){ localStorage.setItem(STORAGE_KEY, v); break; }
        }
      }
      if(!localStorage.getItem(TYPES_KEY)) saveTypes(DEFAULT_TYPES);
    }catch{}
  })();

  const load = ()=> { try{ const a = JSON.parse(localStorage.getItem(STORAGE_KEY)||'[]'); return Array.isArray(a)?a:[]; }catch{ return []; } };
  const save = a  => localStorage.setItem(STORAGE_KEY, JSON.stringify(a));

  const normalize = arr => (Array.isArray(arr)?arr:[]).map((x,i)=>({
    id: coerceId(x.id) || (i+1),
    title: x.title||'',
    type: (x.type && String(x.type)) || loadTypes()[0] || 'บ้าน',
    price: (x.price===''||x.price==null)?'':Number(x.price),
    priceUnit: x.priceUnit||'',
    desc: x.desc||'',
    fbUrl: x.fbUrl||'',
    lat: (x.lat===''||x.lat==null)?'':Number(x.lat),
    lng: (x.lng===''||x.lng==null)?'':Number(x.lng),
    imageKeys: Array.isArray(x.imageKeys) ? x.imageKeys : []
  }));

  /* ===================== IndexedDB (images) ===================== */
  function openDB(){
    return new Promise((res,rej)=>{
      const r = indexedDB.open(DB_NAME,1);
      r.onupgradeneeded = e => {
        const db = e.target.result;
        if(!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
      };
      r.onsuccess = ()=> res(r.result);
      r.onerror   = ()=> rej(r.error);
    });
  }
  async function idbPut(key, blob){
    const db = await openDB();
    return new Promise((res,rej)=>{
      const tx = db.transaction(STORE,'readwrite');
      tx.objectStore(STORE).put(blob, key);
      tx.oncomplete = ()=> res();
      tx.onerror    = ()=> rej(tx.error);
    });
  }
  async function idbGet(key){
    const db = await openDB();
    return new Promise((res,rej)=>{
      const tx = db.transaction(STORE,'readonly');
      const rq = tx.objectStore(STORE).get(key);
      rq.onsuccess = ()=> res(rq.result || null);
      rq.onerror   = ()=> rej(rq.error);
    });
  }
  async function idbDelete(key){
    const db = await openDB();
    return new Promise((res,rej)=>{
      const tx = db.transaction(STORE,'readwrite');
      tx.objectStore(STORE).delete(key);
      tx.oncomplete = ()=> res();
      tx.onerror    = ()=> rej(tx.error);
    });
  }
  function compressImage(file, max=1280, quality=0.8){
    return new Promise((resolve,reject)=>{
      const img = new Image(), fr = new FileReader();
      fr.onload = ()=> { img.src = fr.result; };
      fr.onerror = reject;
      img.onload = ()=>{
        const long = Math.max(img.width, img.height);
        const scale = Math.min(1, max/long);
        const w = Math.round(img.width * scale), h = Math.round(img.height * scale);
        const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
        const ctx = cv.getContext('2d'); ctx.drawImage(img,0,0,w,h);
        cv.toBlob(b=> b? resolve(b) : reject(new Error('toBlob failed')), 'image/jpeg', quality);
      };
      img.onerror = reject;
      fr.readAsDataURL(file);
    });
  }
  async function imgURL(key){
    const b = await idbGet(key);
    return b ? URL.createObjectURL(b) : '';
  }

  /* ===================== INDEX PAGE ===================== */
  if(byId('map')){
    setYear();

    // Leaflet map
    const map = L.map('map').setView([13.736717,100.523186], 6);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:19}).addTo(map);
    const markers = L.layerGroup().addTo(map);
    const markerById = new Map();

    const iconThumb = url => L.divIcon({
      html:`<div class="thumb-marker">${url?`<img src="${url}">`:''}</div>`,
      className:'', iconSize:[52,52], iconAnchor:[26,26], popupAnchor:[0,-28]
    });

    const listEl = byId('listings');
    const fltType = byId('fltType'), fltMin = byId('fltMin'), fltMax = byId('fltMax');

    // เติมประเภทตัวกรอง
    (function fillTypesForIndex(){
      const types = loadTypes();
      if(fltType){
        const first = fltType.querySelector('option[value=""]');
        fltType.innerHTML = '';
        if(first) fltType.appendChild(first);
        types.forEach(t=>{
          const op = document.createElement('option');
          op.value = t; op.textContent = t;
          fltType.appendChild(op);
        });
      }
    })();

    byId('applyFilter')?.addEventListener('click', renderIndex);
    byId('clearFilter')?.addEventListener('click', ()=>{ if(fltType) fltType.value=''; if(fltMin) fltMin.value=''; if(fltMax) fltMax.value=''; renderIndex(); });

    // ค้นหาที่อยู่ (Nominatim)
    const addrQuery = byId('addrQuery'), addrBtn = byId('addrSearch'), addrRes = byId('addrResults');
    addrBtn?.addEventListener('click', async ()=>{
      const q = (addrQuery?.value||'').trim(); if(!q) return;
      addrRes.innerHTML = 'กำลังค้นหา...';
      try{
        const url = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(q)}&addressdetails=1&limit=6`;
        const r = await fetch(url,{headers:{'Accept':'application/json'}});
        const data = await r.json();
        if(!data.length){ addrRes.innerHTML='<div class="small">ไม่พบผลลัพธ์</div>'; return; }
        addrRes.innerHTML = data.map(d=>`
          <div class="addr-item" data-lat="${d.lat}" data-lng="${d.lon}">
            ${d.display_name}
          </div>
        `).join('');
        addrRes.querySelectorAll('.addr-item').forEach(el=>{
          el.addEventListener('click', ()=>{
            const lat = +el.getAttribute('data-lat'), lng = +el.getAttribute('data-lng');
            map.flyTo([lat,lng], 15, {duration:0.6});
          });
        });
      }catch{ addrRes.innerHTML='<div class="small">เกิดข้อผิดพลาดในการค้นหา</div>'; }
    });

    const passFilter = it => {
      if(fltType?.value && it.type !== fltType.value) return false;
      if(fltMin?.value && +it.price < +fltMin.value) return false;
      if(fltMax?.value && +it.price > +fltMax.value) return false;
      return true;
    };

    /* ====== แกลเลอรี (แยกรูปหลัก/รูปย่อย + lightbox) ====== */
    async function mountGallery(containerId, imageKeys){
      const wrap = document.getElementById(containerId);
      if(!wrap) return;

      if(!imageKeys?.length){
        wrap.innerHTML = '<div class="detail-empty">ไม่มีรูปภาพ</div>';
        return;
      }

      // สร้าง URL ทั้งหมดจาก IndexedDB
      const urls = [];
      for (const k of imageKeys) { urls.push(await imgURL(k)); }
      let current = 0;

      function render(){
        wrap.innerHTML = `
          <div class="gallery-wrap">
            <img class="gallery-main" src="${urls[current] || ''}" alt="">
          </div>
          <div class="detail-gallery">
            ${urls.map((u,i)=>`<img src="${u}" data-i="${i}" alt="">`).join('')}
          </div>
        `;

        // คลิก thumb -> เปลี่ยนภาพหลัก
        wrap.querySelectorAll('.detail-gallery img').forEach(img=>{
          img.addEventListener('click', ()=>{
            current = +img.getAttribute('data-i');
            const main = wrap.querySelector('.gallery-main');
            if (main) main.src = urls[current] || '';
          });
        });

        // คลิกภาพหลัก -> เปิดเต็มจอ
        const main = wrap.querySelector('.gallery-main');
        if(main){
          main.style.cursor = 'zoom-in';
          main.addEventListener('click', ()=> openLightbox(main.src));
        }

        // รองรับคีย์บอร์ด ซ้าย/ขวา (เมื่อโฟกัสในกรอบ)
        wrap.tabIndex = 0;
        wrap.onkeydown = (e)=>{
          if(e.key === 'ArrowLeft'){
            current = (current - 1 + urls.length) % urls.length;
            wrap.querySelector('.gallery-main').src = urls[current];
          }
          if(e.key === 'ArrowRight'){
            current = (current + 1) % urls.length;
            wrap.querySelector('.gallery-main').src = urls[current];
          }
        };
      }

      render();
    }

    // แผงรายละเอียดด้านขวา (overlay — listings ไม่หด)
    async function openDetail(it){
      const panel = byId('detailPanel');
      const col   = panel?.parentElement; // .list-col
      if(!panel || !col) return;

      const galId = `detail-gal-${coerceId(it.id)}`;

      panel.innerHTML = `
        <div class="detail-head">
          <b>${it.title || '-'}</b>
          <button id="detailClose" class="btn-ghost">ปิด</button>
        </div>
        <div class="detail-body">
          <div id="${galId}"></div>
          <div class="line small" style="margin-top:8px;">
            ${it.type||'-'} • ${baht(it.price)} ${it.priceUnit?`(${it.priceUnit})`:''}
          </div>
          ${it.desc ? `<div class="line small">${it.desc}</div>` : ``}
          <div class="detail-actions">
            ${it.lat&&it.lng ? `<a class="btn btn-secondary" target="_blank" href="${mapLink(it.lat,it.lng)}">ดูแผนที่</a>` : ``}
            ${it.fbUrl ? `<a class="btn btn-secondary" target="_blank" href="${it.fbUrl}">โพสต์ Facebook</a>` : ``}
          </div>
        </div>
      `;

      panel.style.display = 'block';
      panel.classList.add('is-open');
      col.classList.add('has-detail');
      panel.scrollTop = 0;

      if(it.imageKeys?.length){ await mountGallery(galId, it.imageKeys); }

      byId('detailClose')?.addEventListener('click', ()=>{
        panel.classList.remove('is-open');
        col.classList.remove('has-detail');
        panel.style.display = 'none';
        panel.innerHTML = '';
      });
    }

    // Render index (markers + list)
    async function renderIndex(){
      const data = normalize(load()).filter(passFilter);
      markers.clearLayers(); markerById.clear(); listEl.innerHTML='';

      let bounds = [];
      for(const it of data){
        // รูปแรกบนมาร์กเกอร์/การ์ด
        let firstURL = '';
        if(it.imageKeys?.[0]){
          try{ firstURL = await imgURL(it.imageKeys[0]); }catch{}
        }

        // marker
        if(it.lat && it.lng){
          const mk = L.marker([it.lat,it.lng], {icon: iconThumb(firstURL)}).addTo(markers);
          if(firstURL){
            mk.bindTooltip(`<img src="${firstURL}">`, {direction:'top', offset:[0,-30], sticky:true, opacity:1, className:'thumb-tip'});
          }
          mk.on('click', ()=> openDetail(it));
          markerById.set(coerceId(it.id), mk);
          bounds.push([it.lat, it.lng]);
        }

        // card ใน #listings (สกอลล์เฉพาะกรอบ จาก CSS)
        const card = document.createElement('div');
        card.className = 'card-item glass';
        card.setAttribute('data-id', coerceId(it.id));

        const imgEl = document.createElement('img');
        imgEl.alt=''; imgEl.src = firstURL || 'data:image/svg+xml;base64,PHN2Zy8+';

        const content = document.createElement('div');
        content.className = 'content';
        content.innerHTML = `
          <div><b>${it.title||'-'}</b></div>
          <div class="price-plain">${baht(it.price)} ${it.priceUnit?`<span class="unit">${it.priceUnit}</span>`:''}</div>
          <div class="btn-row" style="margin-top:6px">
            ${it.lat&&it.lng ? `<a class="btn btn-secondary" target="_blank" href="${mapLink(it.lat,it.lng)}">ดูแผนที่</a>`:''}
            ${it.fbUrl ? `<a class="btn btn-secondary" target="_blank" href="${it.fbUrl}">โพสต์ Facebook</a>`:''}
          </div>
        `;
        card.appendChild(imgEl); card.appendChild(content);
        card.addEventListener('click', ()=>{
          if(it.lat&&it.lng){ map.flyTo([it.lat,it.lng], 15, {duration:0.6}); }
          openDetail(it);
        });
        listEl.appendChild(card);
      }
      if(bounds.length) map.fitBounds(bounds, {padding:[20,20]});
    }

    renderIndex();
  }

  /* ===================== ADMIN PAGE (อยู่ไฟล์ admin.html) ===================== */
  if(byId('loginBox')){
    setYear();

    const loginBox = byId('loginBox'), adminBox = byId('adminBox');
    byId('loginBtn').onclick = ()=>{
      const input = (byId('password').value||'').trim();
      const pass  = (localStorage.getItem(PASS_KEY)||DEFAULT_PASS).trim();
      if(input===pass){ loginBox.style.display='none'; adminBox.style.display='block'; initAdmin(); }
      else alert('รหัสผ่านไม่ถูกต้อง');
    };
    byId('resetBtn').onclick = ()=>{
      const np = prompt('ตั้งรหัสผ่านใหม่', DEFAULT_PASS);
      if(np){ localStorage.setItem(PASS_KEY, np); alert('เปลี่ยนรหัสแล้ว'); }
    };
  }

  /* ====== ส่วน Admin ใช้ร่วมกับ admin.html ====== */
  function initAdmin(){
    // ฟอร์มเพิ่มใหม่
    const f_title=byId('f_title'), f_type=byId('f_type'), f_price=byId('f_price'),
          f_priceUnit=byId('f_priceUnit'), f_desc=byId('f_desc'),
          f_fbUrl=byId('f_fbUrl'), f_gmap=byId('f_gmap'),
          f_lat=byId('f_lat'), f_lng=byId('f_lng'), f_imgs=byId('f_imgs');
    const saveBtn=byId('saveBtn'), exportBtn=byId('exportBtn'), importBtn=byId('importBtn'), importFile=byId('importFile');

    // Modal แก้ไข
    const editModal=byId('editModal'), closeEdit=byId('closeEdit');
    const e_id=byId('e_id'), e_title=byId('e_title'), e_type=byId('e_type'), e_price=byId('e_price'),
          e_priceUnit=byId('e_priceUnit'), e_desc=byId('e_desc'), e_fbUrl=byId('e_fbUrl'),
          e_gmap=byId('e_gmap'), e_lat=byId('e_lat'), e_lng=byId('e_lng'),
          e_imgs=byId('e_imgs'), e_imgsPrev=byId('e_imgsPrev'),
          e_updateBtn=byId('e_updateBtn'), e_deleteBtn=byId('e_deleteBtn');

    // จัดการประเภท
    const typeInput = byId('typeInput'), typeAddBtn = byId('typeAddBtn'), typeChips = byId('typeChips');
    function refreshTypeSelects(){ renderTypeOptions([f_type, e_type]); }
    function renderTypeChips(){
      const types=loadTypes();
      typeChips.innerHTML = types.map(t=>`
        <span class="chip">${t} <button class="del" data-t="${t}" title="ลบประเภทนี้">×</button></span>
      `).join('');
      typeChips.querySelectorAll('.del').forEach(btn=>{
        btn.onclick=()=>{
          const t=btn.getAttribute('data-t');
          const cur=loadTypes();
          if(cur.length<=1){ alert('ต้องมีอย่างน้อย 1 ประเภท'); return; }
          if(!confirm(`ลบประเภท "${t}" ?`)) return;
          saveTypes(cur.filter(x=>x!==t));
          renderTypeChips(); refreshTypeSelects();
        };
      });
    }
    refreshTypeSelects(); renderTypeChips();
    typeAddBtn.onclick=()=>{
      const name=(typeInput.value||'').trim();
      if(!name) return alert('กรุณาใส่ชื่อประเภท');
      const cur=loadTypes().map(s=>s.toLowerCase());
      if(cur.includes(name.toLowerCase())) return alert('มีประเภทนี้อยู่แล้ว');
      saveTypes([...loadTypes(), name]);
      typeInput.value=''; renderTypeChips(); refreshTypeSelects();
    };

    // แผนที่รวม (Admin)
    const allMap = L.map('allMap').setView([13.736717,100.523186],6);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:19}).addTo(allMap);
    const allMarkers = L.layerGroup().addTo(allMap);
    const iconThumb = url => L.divIcon({html:`<div class="thumb-marker">${url?`<img src="${url}">`:''}</div>`, className:'', iconSize:[52,52], iconAnchor:[26,26]});

    let items = normalize(load());
    let add_imageKeys = [];   // เพิ่มใหม่
    let edit_imageKeys = [];  // แก้ไข

    // ดึงพิกัดอัตโนมัติจากลิงก์ (เพิ่มใหม่/แก้ไข)
    f_gmap.onchange = ()=>{ const g=parseGmapLink(f_gmap.value); if(g){ f_lat.value=g.lat; f_lng.value=g.lng; } };
    e_gmap.onchange = ()=>{ const g=parseGmapLink(e_gmap.value); if(g){ e_lat.value=g.lat; e_lng.value=g.lng; } };

    // อัปโหลดรูป (เพิ่มใหม่)
    f_imgs.onchange = async ()=>{
      add_imageKeys = [];
      const files = Array.from(f_imgs.files||[]).slice(0,12);
      for(let i=0;i<files.length;i++){
        const b = await compressImage(files[i],1280,.8);
        const key = `img_${Date.now()}_${i}_${Math.random().toString(36).slice(2,8)}`;
        await idbPut(key,b); add_imageKeys.push(key);
      }
      renderAddPreviews();
    };
    function renderAddPreviews(){
      const p = byId('imgsPrev'); p.innerHTML = '';
      add_imageKeys.forEach(async k=>{ const u=await imgURL(k); const im=new Image(); im.src=u; p.appendChild(im); });
    }

    // เพิ่มใหม่
    saveBtn.onclick = ()=>{
      items = normalize(load());
      const rec = {
        id: nextId(items),
        title: f_title.value||'',
        type: f_type.value || (loadTypes()[0]||'บ้าน'),
        price: f_price.value? +f_price.value : '',
        priceUnit: f_priceUnit.value||'',
        desc: f_desc.value||'',
        fbUrl: (f_fbUrl.value||'').trim(),
        lat: pFloat(f_lat.value),
        lng: pFloat(f_lng.value),
        imageKeys: add_imageKeys.slice(0,12)
      };
      items.push(rec); save(items); items = normalize(load());
      byId('listingForm').reset(); add_imageKeys=[]; renderAddPreviews();
      renderTable(); alert('เพิ่มประกาศแล้ว');
    };

    // อัปโหลดรูป (แก้ไข)
    e_imgs.onchange = async ()=>{
      edit_imageKeys = [];
      const files = Array.from(e_imgs.files||[]).slice(0,12);
      for(let i=0;i<files.length;i++){
        const b = await compressImage(files[i],1280,.8);
        const key = `img_${Date.now()}_${i}_${Math.random().toString(36).slice(2,8)}`;
        await idbPut(key,b); edit_imageKeys.push(key);
      }
      e_imgsPrev.innerHTML = '';
      edit_imageKeys.forEach(async k=>{ const u=await imgURL(k); const im=new Image(); im.src=u; e_imgsPrev.appendChild(im); });
    };

    // Export JSON (พกรูปไปด้วย)
    exportBtn.onclick = async ()=>{
      const items = normalize(load());
      const images = {}; // {key: dataURL}
      for(const it of items){
        if(Array.isArray(it.imageKeys)){
          for(const key of it.imageKeys){
            if(!key || images[key]) continue;
            try{
              const blob = await idbGet(key);
              if(blob) images[key] = await blobToDataURL(blob);
            }catch{}
          }
        }
      }
      const payload = {
        metaVersion: 'v8i+img',
        exportedAt: new Date().toISOString(),
        items,
        images
      };
      const blob = new Blob([JSON.stringify(payload,null,2)], {type:'application/json'});
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'listings-with-images.json';
      a.click();
      setTimeout(()=>URL.revokeObjectURL(a.href), 1000);
    };

    // Import JSON (เขียนรูปกลับ IndexedDB)
    importBtn.onclick = ()=> importFile.click();
    importFile.onchange = ()=>{
      const f = importFile.files?.[0]; if(!f) return;
      const r = new FileReader();
      r.onload = async (e)=>{
        try{
          const raw = JSON.parse(e.target.result || '{}');
          let arr, images;
          if(Array.isArray(raw)){
            arr = normalize(raw); images = null;
          }else{
            arr = normalize(raw.items || []); images = raw.images || null;
          }
          // แก้ id ซ้ำ
          const used = new Set();
          arr = arr.map((x,i)=>{ let id = Number(x.id) || (i+1); while(used.has(id)) id++; used.add(id); return {...x, id}; });

          // เขียนรูปกลับ IndexedDB
          if(images && typeof images === 'object'){
            for(const [key, dataURL] of Object.entries(images)){
              if(!key || !dataURL) continue;
              try{ await idbPut(key, dataURLToBlob(String(dataURL))); }catch{}
            }
          }else{
            console.warn('Imported JSON has no images.');
            alert('ไฟล์นำเข้าไม่มีข้อมูลรูปภาพ (meta-only)\nรูปจะไม่แสดงจนกว่าจะอัปโหลดใหม่หรือใช้งานไฟล์ส่งออกแบบใหม่ที่มีรูป');
          }

          save(arr); items = normalize(load()); renderTable(); alert('นำเข้าเรียบร้อย');
        }catch(err){
          console.error(err); alert('ไฟล์ไม่ถูกต้อง');
        }
      };
      r.readAsText(f);
    };

    // Modal Edit
    function openEdit(it){
      e_id.value = coerceId(it.id);
      e_title.value = it.title||'';
      renderTypeOptions([e_type]);
      e_type.value = loadTypes().includes(it.type) ? it.type : (loadTypes()[0]||'บ้าน');
      e_price.value = (it.price===''||it.price==null)?'':it.price;
      e_priceUnit.value = it.priceUnit||'';
      e_desc.value = it.desc||'';
      e_fbUrl.value = it.fbUrl||'';
      e_lat.value = (it.lat===''||it.lat==null)?'':it.lat;
      e_lng.value = (it.lng===''||it.lng==null)?'':it.lng;
      e_gmap.value = '';
      edit_imageKeys = [];
      e_imgsPrev.innerHTML = '';
      editModal.style.display = 'flex';
    }
    closeEdit.onclick = ()=>{ editModal.style.display='none'; };

    e_updateBtn.onclick = ()=>{
      const id = coerceId(e_id.value); if(!id) return;
      let items = normalize(load());
      const idx = items.findIndex(x=>coerceId(x.id)===id);
      if(idx<0) return alert('ไม่พบรายการ');

      const useKeys = edit_imageKeys.length ? edit_imageKeys.slice(0,12) : items[idx].imageKeys||[];
      items[idx] = {...items[idx],
        title: e_title.value||'',
        type: e_type.value || (loadTypes()[0]||'บ้าน'),
        price: e_price.value? +e_price.value : '',
        priceUnit: e_priceUnit.value||'',
        desc: e_desc.value||'',
        fbUrl: (e_fbUrl.value||'').trim(),
        lat: pFloat(e_lat.value),
        lng: pFloat(e_lng.value),
        imageKeys: useKeys
      };
      save(items); items = normalize(load()); renderTable(); alert('อัปเดตแล้ว'); editModal.style.display='none';
    };

    e_deleteBtn.onclick = async ()=>{
      const id = coerceId(e_id.value); if(!id) return;
      if(!confirm('ยืนยันลบ #' + id + ' ?')) return;
      let items = normalize(load());
      const it = items.find(x=>coerceId(x.id)===id);
      if(it?.imageKeys?.length){ for(const k of it.imageKeys){ try{ await idbDelete(k);}catch{} } }
      items = items.filter(x=>coerceId(x.id)!==id);
      save(items); items = normalize(load()); renderTable(); alert('ลบแล้ว'); editModal.style.display='none';
    };

    function renderTable(){
      const wrap = byId('tableWrap');
      const items = normalize(load());
      const rows = items.map(it=>`
        <tr data-id="${coerceId(it.id)}">
          <td>${coerceId(it.id)}</td>
          <td>${it.title||'-'}</td>
          <td>${it.type||'-'}</td>
          <td>${baht(it.price)} ${it.priceUnit?`(${it.priceUnit})`:''}</td>
          <td>${(it.lat&&it.lng)? `${Number(it.lat).toFixed(5)},${Number(it.lng).toFixed(5)}` : '-'}</td>
          <td>${it.fbUrl? 'มีลิงก์' : '-'}</td>
          <td class="btn-row">
            <button class="btn-ghost row-edit" data-id="${coerceId(it.id)}">แก้ไข</button>
            <button class="btn-ghost row-del" data-id="${coerceId(it.id)}">ลบ</button>
          </td>
        </tr>
      `).join('');
      wrap.innerHTML = `
        <table>
          <thead><tr><th>ID</th><th>หัวข้อ</th><th>ประเภท</th><th>ราคา</th><th>พิกัด</th><th>Facebook</th><th></th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      `;

      // ปุ่มแก้ไข
      wrap.querySelectorAll('.row-edit').forEach(btn=>{
        btn.addEventListener('click', ()=>{
          const id = coerceId(btn.getAttribute('data-id'));
          const it = items.find(x=>coerceId(x.id)===id); if(!it) return;
          openEdit(it);
        });
      });

      // ปุ่มลบ
      wrap.querySelectorAll('.row-del').forEach(btn=>{
        btn.addEventListener('click', async ()=>{
          const id = coerceId(btn.getAttribute('data-id'));
          if(!confirm('ยืนยันลบ #' + id + ' ?')) return;
          const all = normalize(load());
          const it = all.find(x=>coerceId(x.id)===id);
          if(it?.imageKeys?.length){ for(const k of it.imageKeys){ try{ await idbDelete(k);}catch{} } }
          const rest = all.filter(x=>coerceId(x.id)!==id);
          save(rest); renderTable();
        });
      });

      // วาดแผนที่รวม (ในหน้า admin.html เท่านั้น)
      const allMap = byId('allMap') && L.map ? L.map : null;
    }

    renderTable();
  }

  setYear();
});
