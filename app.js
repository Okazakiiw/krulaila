// app.js — Firestore + Google Drive (Apps Script) with delete support (Full, fixed image URLs)

window.addEventListener('DOMContentLoaded', () => {
  /* ============ Lightbox ============ */
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

  /* ============ Firebase (Firestore only) ============ */
  try{
    if(!window.firebaseConfig) console.warn('Missing window.firebaseConfig');
    firebase.initializeApp(window.firebaseConfig || {});
  }catch(e){
    console.error('Firebase init error:', e);
  }
  const db = firebase.firestore?.();

  /* ============ Apps Script URL ============ */
  const GAS_UPLOAD_URL = (window.GAS_UPLOAD_URL || '').trim();
  if(!GAS_UPLOAD_URL){
    console.warn('Missing GAS_UPLOAD_URL. Set window.GAS_UPLOAD_URL in HTML.');
  }

  /* ============ Helpers ============ */
  const byId = s => document.getElementById(s);
  const setYear = () => { const y = byId('year'); if (y) y.textContent = new Date().getFullYear(); };
  const coerceNum = v => (v===''||v==null) ? '' : Number(v);
  const baht = n => (n!=='' && n!=null) ? Number(n).toLocaleString() + ' บาท' : '-';
  const mapLink = (lat,lng)=> `https://www.google.com/maps?q=${lat},${lng}`;
  const parseGmapLink = (url)=>{
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
  };

  // ✅ แปลง URL จาก Google Drive ให้เป็นลิงก์รูปตรง (ลดปัญหารูปไม่ขึ้น)
  function normalizeDriveImageURL(u) {
    if (!u) return '';
    try {
      // uc?export=view&id=ID
      if (u.includes('uc?')) {
        const sp = new URL(u).searchParams;
        const id = sp.get('id');
        if (id) return `https://lh3.googleusercontent.com/d/${id}=s1200`;
      }
      // open?id=ID
      if (u.includes('/open?')) {
        const sp = new URL(u).searchParams;
        const id = sp.get('id');
        if (id) return `https://lh3.googleusercontent.com/d/${id}=s1200`;
      }
      // /file/d/ID/view
      const m = u.match(/\/file\/d\/([^/]+)/);
      if (m && m[1]) return `https://lh3.googleusercontent.com/d/${m[1]}=s1200`;
    } catch (e) {}
    return u;
  }

  // ดึง URL รูปจากเอกสาร (รองรับทั้ง imageObjs และ imageURLs) + แปลงเป็นรูปตรง
  const getImageURLs = (it) => {
    if (Array.isArray(it.imageObjs))  return it.imageObjs.map(o=>normalizeDriveImageURL(o.url)).filter(Boolean);
    if (Array.isArray(it.imageURLs))  return it.imageURLs.map(u=>normalizeDriveImageURL(u)).filter(Boolean);
    return [];
  };

  const rulesHint = (label='บันทึก/แก้ไข')=>alert(
`❌ Firestore: Missing or insufficient permissions

ให้ไปที่ Firebase Console → Firestore → Rules แล้วใช้ชั่วคราว:

rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /{document=**} {
      allow read, write: if true;
    }
  }
}

กด Publish แล้วลอง "${label}" อีกครั้งครับ`
  );

  /* ============ Image compress -> dataURL ============ */
  function compressImageToDataURL(file, max=1280, quality=0.8){
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
        cv.toBlob(b=>{
          const fr2 = new FileReader();
          fr2.onload = ()=> resolve(fr2.result); // dataURL
          fr2.onerror = reject;
          fr2.readAsDataURL(b);
        }, 'image/jpeg', quality);
      };
      img.onerror = reject;
      fr.readAsDataURL(file);
    });
  }

  /* ============ Drive Upload/Delete via Apps Script (simple CORS) ============ */
  async function uploadToDrive(files){
    if(!GAS_UPLOAD_URL) throw new Error('GAS_UPLOAD_URL is not set');

    const list = [];
    for (let i=0;i<files.length;i++){
      const dataURL = await compressImageToDataURL(files[i], 1280, .8);
      list.push({ name: files[i].name || `img_${Date.now()}_${i}.jpg`, dataURL });
    }

    // ใช้ text/plain เพื่อหลีกเลี่ยง preflight (OPTIONS)
    const res = await fetch(GAS_UPLOAD_URL, {
      method: 'POST',
      headers: { 'Content-Type':'text/plain;charset=utf-8' },
      body: JSON.stringify({ action:'upload', files: list })
    });

    const json = await res.json();
    if(!json.ok) throw new Error(json.error || 'Upload failed');
    return json.items; // [{id,url,name}]
  }

  async function deleteDriveFiles(ids){
    if(!GAS_UPLOAD_URL) throw new Error('GAS_UPLOAD_URL is not set');

    const res = await fetch(GAS_UPLOAD_URL, {
      method: 'POST',
      headers: { 'Content-Type':'text/plain;charset=utf-8' },
      body: JSON.stringify({ action:'delete', ids })
    });

    const json = await res.json();
    if(!json.ok) throw new Error(json.error || 'Delete failed');
    return json;
  }

  /* ===================== INDEX PAGE ===================== */
  if(byId('map') && db){
    setYear();

    const map = L.map('map').setView([13.736717,100.523186], 6);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:19}).addTo(map);
    const markers = L.layerGroup().addTo(map);

    const listEl = byId('listings');
    const fltType = byId('fltType'), fltMin = byId('fltMin'), fltMax = byId('fltMax');
    const addrQuery = byId('addrQuery'), addrBtn = byId('addrSearch'), addrRes = byId('addrResults');

    // load types
    (async ()=>{
      try{
        const doc = await db.collection('meta').doc('types').get();
        const arr = doc.exists && Array.isArray(doc.data().list) ? doc.data().list : ['บ้าน','ที่ดิน'];
        const first = fltType?.querySelector('option[value=""]');
        if(fltType){
          fltType.innerHTML = '';
          if(first) fltType.appendChild(first);
          arr.forEach(t=>{
            const op = document.createElement('option');
            op.value=t; op.textContent=t;
            fltType.appendChild(op);
          });
        }
      }catch(e){
        console.warn('load types error:', e);
      }
    })();

    // address search
    addrBtn?.addEventListener('click', async ()=>{
      const q = (addrQuery?.value||'').trim(); if(!q || !addrRes) return;
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

    function iconThumb(url){
      return L.divIcon({
        html:`<div class="thumb-marker">${url?`<img src="${url}">`:''}</div>`,
        className:'', iconSize:[52,52], iconAnchor:[26,26], popupAnchor:[0,-28]
      });
    }

    function buildCard(it, firstURL){
      const card = document.createElement('div');
      card.className = 'card-item glass';
      const imgEl = document.createElement('img');
      imgEl.alt=''; imgEl.src = firstURL || 'data:image/svg+xml;base64,PHN2Zy8+';
      const content = document.createElement('div'); content.className = 'content';
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
      return card;
    }

    async function mountGallery(containerId, imageURLs){
      const wrap = document.getElementById(containerId);
      if(!wrap){ return; }
      if(!imageURLs?.length){ wrap.innerHTML = '<div class="detail-empty">ไม่มีรูปภาพ</div>'; return; }
      let current = 0;
      function render(){
        wrap.innerHTML = `
          <div class="gallery-wrap">
            <img class="gallery-main" src="${imageURLs[current] || ''}" alt="">
          </div>
          <div class="detail-gallery">
            ${imageURLs.map((u,i)=>`<img src="${u}" data-i="${i}" alt="">`).join('')}
          </div>
        `;
        wrap.querySelectorAll('.detail-gallery img').forEach(img=>{
          img.addEventListener('click', ()=>{
            current = +img.getAttribute('data-i');
            wrap.querySelector('.gallery-main').src = imageURLs[current] || '';
          });
        });
        const main = wrap.querySelector('.gallery-main');
        if(main){
          main.style.cursor = 'zoom-in';
          main.addEventListener('click', ()=> openLightbox(main.src));
        }
      }
      render();
    }

    async function openDetail(it){
      const panel = byId('detailPanel');
      const col   = panel?.parentElement;
      if(!panel || !col) return;
      const urls = getImageURLs(it);

      const galId = `detail-gal-${it.id}`;
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

      if(urls.length){ await mountGallery(galId, urls); }

      byId('detailClose')?.addEventListener('click', ()=>{
        panel.classList.remove('is-open');
        col.classList.remove('has-detail');
        panel.style.display = 'none';
        panel.innerHTML = '';
      });
    }

    async function fetchListings(){
      try{
        const snap = await db.collection('listings').orderBy('createdAt','desc').get();
        return snap.docs.map(d=>({ id: d.id, ...d.data() }));
      }catch(err){
        console.error('fetchListings error:', err);
        if(String(err).includes('Missing or insufficient permissions')) rulesHint('เปิดหน้าเว็บ');
        return [];
      }
    }

    async function renderIndex(){
      const dataAll = await fetchListings();
      const data = dataAll.filter(passFilter);
      markers.clearLayers(); if(listEl) listEl.innerHTML='';

      let bounds = [];
      for (const it of data){
        const urls = getImageURLs(it);
        const firstURL = urls[0] || '';

        if(it.lat && it.lng){
          const mk = L.marker([it.lat,it.lng], {icon: iconThumb(firstURL)}).addTo(markers);
          if(firstURL){
            mk.bindTooltip(`<img src="${firstURL}">`, {direction:'top', offset:[0,-30], sticky:true, opacity:1, className:'thumb-tip'});
          }
          mk.on('click', ()=> openDetail(it));
          bounds.push([it.lat, it.lng]);
        }

        if(listEl) listEl.appendChild(buildCard(it, firstURL));
      }
      if(bounds.length) map.fitBounds(bounds, {padding:[20,20]});
    }

    byId('applyFilter')?.addEventListener('click', renderIndex);
    byId('clearFilter')?.addEventListener('click', ()=>{
      if(fltType) fltType.value='';
      if(fltMin) fltMin.value='';
      if(fltMax) fltMax.value='';
      renderIndex();
    });

    renderIndex();
  }

  /* ===================== ADMIN PAGE ===================== */
  if(byId('loginBox') && db){
    setYear();

    const PASS_KEY = 're_admin_pass';
    const DEFAULT_PASS = 'admin123';

    const loginBox = byId('loginBox'), adminBox = byId('adminBox');
    byId('loginBtn')?.addEventListener('click', ()=>{
      const input = (byId('password').value||'').trim();
      const pass  = (localStorage.getItem(PASS_KEY)||DEFAULT_PASS).trim();
      if(input===pass){ if(loginBox) loginBox.style.display='none'; if(adminBox) adminBox.style.display='block'; initAdmin(); }
      else alert('รหัสผ่านไม่ถูกต้อง');
    });
    byId('resetBtn')?.addEventListener('click', ()=>{
      const np = prompt('ตั้งรหัสผ่านใหม่', DEFAULT_PASS);
      if(np){ localStorage.setItem(PASS_KEY, np); alert('เปลี่ยนรหัสแล้ว'); }
    });
  }

  async function initAdmin(){
    const f_title=byId('f_title'), f_type=byId('f_type'), f_price=byId('f_price'),
          f_priceUnit=byId('f_priceUnit'), f_desc=byId('f_desc'),
          f_fbUrl=byId('f_fbUrl'), f_gmap=byId('f_gmap'),
          f_lat=byId('f_lat'), f_lng=byId('f_lng'), f_imgs=byId('f_imgs');
    const saveBtn=byId('saveBtn'), exportBtn=byId('exportBtn'), importBtn=byId('importBtn'), importFile=byId('importFile');

    const editModal=byId('editModal'), closeEdit=byId('closeEdit');
    const e_id=byId('e_id'), e_title=byId('e_title'), e_type=byId('e_type'), e_price=byId('e_price'),
          e_priceUnit=byId('e_priceUnit'), e_desc=byId('e_desc'), e_fbUrl=byId('e_fbUrl'),
          e_gmap=byId('e_gmap'), e_lat=byId('e_lat'), e_lng=byId('e_lng'),
          e_imgs=byId('e_imgs'), e_imgsPrev=byId('e_imgsPrev'),
          e_updateBtn=byId('e_updateBtn'), e_deleteBtn=byId('e_deleteBtn'),
          e_imgsList=byId('e_imgsList');

    // map (admin)
    const allMap = L.map('allMap').setView([13.736717,100.523186],6);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:19}).addTo(allMap);
    const allMarkers = L.layerGroup().addTo(allMap);
    const iconThumb = url => L.divIcon({html:`<div class="thumb-marker">${url?`<img src="${url}">`:''}</div>`, className:'', iconSize:[52,52], iconAnchor:[26,26]});

    // parse gmap
    f_gmap?.addEventListener('change', ()=>{ const g=parseGmapLink(f_gmap.value); if(g){ f_lat.value=g.lat; f_lng.value=g.lng; } });
    e_gmap?.addEventListener('change', ()=>{ const g=parseGmapLink(e_gmap.value); if(g){ e_lat.value=g.lat; e_lng.value=g.lng; } });

    // load & render types
    async function loadTypes(){
      try{
        const doc = await db.collection('meta').doc('types').get();
        return doc.exists && Array.isArray(doc.data().list) ? doc.data().list : ['บ้าน','ที่ดิน'];
      }catch{return ['บ้าน','ที่ดิน'];}
    }
    function renderTypeOptions(selectEls, types){
      (selectEls||[]).forEach(sel=>{
        if(!sel) return;
        const keep = sel.value;
        sel.innerHTML = types.map(t=>`<option value="${t}">${t}</option>`).join('');
        if(keep && types.includes(keep)) sel.value = keep;
      });
    }
    async function refreshTypesUI(){
      const types = await loadTypes();
      renderTypeOptions([f_type, e_type], types);
    }
    await refreshTypesUI();

    // add previews (new)
    let add_files = [];
    f_imgs?.addEventListener('change', ()=>{
      add_files = Array.from(f_imgs.files||[]).slice(0,12);
      const p = byId('imgsPrev'); if(p) p.innerHTML='';
      add_files.forEach(file=>{
        const im = new Image(); im.src = URL.createObjectURL(file); p?.appendChild(im);
      });
    });

    // create new listing
    saveBtn?.addEventListener('click', async ()=>{
      try{
        const meta = {
          title: (f_title?.value||'').trim(),
          type: (f_type?.value)|| 'บ้าน',
          price: coerceNum(f_price?.value),
          priceUnit: (f_priceUnit?.value||'').trim(),
          desc: (f_desc?.value||'').trim(),
          fbUrl: (f_fbUrl?.value||'').trim(),
          lat: coerceNum(f_lat?.value),
          lng: coerceNum(f_lng?.value),
          imageObjs: [],
          createdAt: firebase.firestore.FieldValue.serverTimestamp(),
          updatedAt: firebase.firestore.FieldValue.serverTimestamp()
        };
        const docRef = await db.collection('listings').add(meta);

        if(add_files.length){
          const items = await uploadToDrive(add_files); // [{id,url,name}]
          await docRef.update({ imageObjs: items, updatedAt: firebase.firestore.FieldValue.serverTimestamp() });
        }

        byId('listingForm')?.reset();
        const prev = byId('imgsPrev'); if(prev) prev.innerHTML='';
        add_files = [];
        alert('เพิ่มประกาศแล้ว');
        await renderTable();
      }catch(err){
        console.error(err);
        if(String(err).includes('Missing or insufficient permissions')) return rulesHint('บันทึก');
        alert('เกิดข้อผิดพลาดในการบันทึก');
      }
    });

    // export/import
    exportBtn?.addEventListener('click', async ()=>{
      try{
        const snap = await db.collection('listings').get();
        const items = snap.docs.map(d=>({ id:d.id, ...d.data() }));
        const payload = { exportedAt: new Date().toISOString(), items };
        const blob = new Blob([JSON.stringify(payload,null,2)], {type:'application/json'});
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = 'listings-export.json';
        a.click();
        setTimeout(()=>URL.revokeObjectURL(a.href), 1000);
      }catch(err){
        console.error(err); alert('ส่งออกล้มเหลว');
      }
    });
    importBtn?.addEventListener('click', ()=> importFile?.click());
    importFile?.addEventListener('change', ()=>{
      const f = importFile.files?.[0]; if(!f) return;
      const r = new FileReader();
      r.onload = async (e)=>{
        try{
          const raw = JSON.parse(e.target.result || '{}');
          const arr = Array.isArray(raw.items) ? raw.items : [];
          for (const item of arr){
            const {id:_drop, ...fields} = item;
            const meta = {
              ...fields,
              createdAt: firebase.firestore.FieldValue.serverTimestamp(),
              updatedAt: firebase.firestore.FieldValue.serverTimestamp()
            };
            await db.collection('listings').add(meta);
          }
          alert('นำเข้าเรียบร้อย');
          await renderTable();
        }catch(err){
          console.error(err); alert('ไฟล์ไม่ถูกต้อง');
        }
      };
      r.readAsText(f);
    });

    // open edit
    function openEdit(it){
      if(!e_id) return;
      e_id.value = it.id;
      if(e_title) e_title.value = it.title||'';
      loadTypes().then(types=>{
        renderTypeOptions([e_type], types);
        if(e_type) e_type.value = types.includes(it.type) ? it.type : (types[0]||'บ้าน');
      });
      if(e_price) e_price.value = (it.price===''||it.price==null)?'':it.price;
      if(e_priceUnit) e_priceUnit.value = it.priceUnit||'';
      if(e_desc) e_desc.value = it.desc||'';
      if(e_fbUrl) e_fbUrl.value = it.fbUrl||'';
      if(e_lat) e_lat.value = (it.lat===''||it.lat==null)?'':it.lat;
      if(e_lng) e_lng.value = (it.lng===''||it.lng==null)?'':it.lng;
      if(e_gmap) e_gmap.value = '';

      const objs = Array.isArray(it.imageObjs) ? it.imageObjs
                : (Array.isArray(it.imageURLs) ? it.imageURLs.map(u=>({id:null,url:normalizeDriveImageURL(u)})) : []);
      if(e_imgsList){
        e_imgsList.innerHTML = objs.length
          ? objs.map(o=>`
              <div style="position:relative">
                <img src="${normalizeDriveImageURL(o.url)}" alt="">
                <button class="btn-ghost" data-file-id="${o.id||''}" data-url="${normalizeDriveImageURL(o.url)}"
                        style="position:absolute;top:6px;right:6px">ลบรูป</button>
              </div>`).join('')
          : '<div class="small muted">— ไม่มีรูป —</div>';

        e_imgsList.querySelectorAll('button[data-url]').forEach(btn=>{
          btn.addEventListener('click', async (ev)=>{
            ev.stopPropagation();
            const fileId = btn.getAttribute('data-file-id') || '';
            const url    = btn.getAttribute('data-url') || '';
            if(!confirm('ลบรูปนี้ออกจากประกาศ' + (fileId?' และ Google Drive':'') + ' ?')) return;

            try{
              if(fileId){ await deleteDriveFiles([fileId]); }
              const ref = db.collection('listings').doc(it.id);
              const snap = await ref.get();
              if(!snap.exists) return;
              const cur = snap.data();
              let arr = Array.isArray(cur.imageObjs) ? cur.imageObjs.slice() : [];
              if(arr.length){
                arr = arr.filter(x => (x.id||'') !== fileId && normalizeDriveImageURL(x.url) !== url);
                await ref.update({ imageObjs: arr, updatedAt: firebase.firestore.FieldValue.serverTimestamp() });
              } else if (Array.isArray(cur.imageURLs)) {
                const urls = cur.imageURLs.map(normalizeDriveImageURL).filter(u => u !== url);
                await ref.update({ imageURLs: urls, updatedAt: firebase.firestore.FieldValue.serverTimestamp() });
              }
              btn.parentElement.remove();
            }catch(err){
              console.error(err);
              if(String(err).includes('Missing or insufficient permissions')) return rulesHint('ลบรูป');
              alert('ลบรูปไม่สำเร็จ');
            }
          });
        });
      }

      if(e_imgs) e_imgs.value = '';
      if(e_imgsPrev) e_imgsPrev.innerHTML = '';
      if(editModal) editModal.style.display = 'flex';
    }
    closeEdit?.addEventListener('click', ()=>{ if(editModal) editModal.style.display='none'; });

    e_imgs?.addEventListener('change', ()=>{
      if(!e_imgsPrev) return;
      e_imgsPrev.innerHTML = '';
      Array.from(e_imgs.files||[]).slice(0,12).forEach(file=>{
        const im = new Image(); im.src = URL.createObjectURL(file); e_imgsPrev.appendChild(im);
      });
    });

    e_updateBtn?.addEventListener('click', async ()=>{
      const id = (e_id?.value||'').trim(); if(!id) return;
      try{
        const ref = db.collection('listings').doc(id);
        const payload = {
          title: e_title?.value||'',
          type: e_type?.value || 'บ้าน',
          price: coerceNum(e_price?.value),
          priceUnit: e_priceUnit?.value||'',
          desc: e_desc?.value||'',
          fbUrl: (e_fbUrl?.value||'').trim(),
          lat: coerceNum(e_lat?.value),
          lng: coerceNum(e_lng?.value),
          updatedAt: firebase.firestore.FieldValue.serverTimestamp()
        };
        await ref.update(payload);

        const newFiles = Array.from(e_imgs?.files||[]);
        if(newFiles.length){
          const items = await uploadToDrive(newFiles);
          const snap = await ref.get();
          const before = snap.data();
          const merged = (Array.isArray(before.imageObjs) ? before.imageObjs : []).concat(items);
          await ref.update({ imageObjs: merged, updatedAt: firebase.firestore.FieldValue.serverTimestamp() });
        }

        alert('อัปเดตแล้ว');
        if(editModal) editModal.style.display='none';
        await renderTable();
      }catch(err){
        console.error(err);
        if(String(err).includes('Missing or insufficient permissions')) return rulesHint('อัปเดต');
        alert('อัปเดตล้มเหลว');
      }
    });

    e_deleteBtn?.addEventListener('click', async ()=>{
      const id = (e_id?.value||'').trim(); if(!id) return;
      if(!confirm('ยืนยันลบ #' + id + ' ?')) return;
      try{
        await db.collection('listings').doc(id).delete();
        alert('ลบแล้ว');
        if(editModal) editModal.style.display='none';
        await renderTable();
      }catch(err){
        console.error(err);
        if(String(err).includes('Missing or insufficient permissions')) return rulesHint('ลบประกาศ');
        alert('ลบล้มเหลว');
      }
    });

    async function fetchAll(){
      try{
        const snap = await db.collection('listings').orderBy('createdAt','desc').get();
        return snap.docs.map(d=>({ id: d.id, ...d.data() }));
      }catch(err){
        console.error('fetchAll error:', err);
        if(String(err).includes('Missing or insufficient permissions')) rulesHint('เปิดหน้าแอดมิน');
        return [];
      }
    }

    async function renderTable(){
      const wrap = byId('tableWrap');
      const items = await fetchAll();

      // map markers
      allMarkers.clearLayers();
      let bounds = [];
      for (const it of items){
        const urls = getImageURLs(it);
        const firstURL = urls[0] || '';
        if(it.lat && it.lng){
          L.marker([it.lat,it.lng], {icon: iconThumb(firstURL)}).addTo(allMarkers);
          bounds.push([it.lat, it.lng]);
        }
      }
      if(bounds.length) allMap.fitBounds(bounds, {padding:[20,20]});

      if(wrap){
        const rows = items.map(it=>`
          <tr data-id="${it.id}">
            <td>${it.id}</td>
            <td>${it.title||'-'}</td>
            <td>${it.type||'-'}</td>
            <td>${baht(it.price)} ${it.priceUnit?`(${it.priceUnit})`:''}</td>
            <td>${(it.lat&&it.lng)? `${Number(it.lat).toFixed(5)},${Number(it.lng).toFixed(5)}` : '-'}</td>
            <td>${it.fbUrl? 'มีลิงก์' : '-'}</td>
            <td class="btn-row">
              <button class="btn-ghost row-edit" data-id="${it.id}">แก้ไข</button>
              <button class="btn-ghost row-del" data-id="${it.id}">ลบ</button>
            </td>
          </tr>
        `).join('');
        wrap.innerHTML = `
          <table>
            <thead><tr><th>ID</th><th>หัวข้อ</th><th>ประเภท</th><th>ราคา</th><th>พิกัด</th><th>Facebook</th><th></th></tr></thead>
            <tbody>${rows}</tbody>
          </table>
        `;

        wrap.querySelectorAll('.row-edit').forEach(btn=>{
          btn.addEventListener('click', async ()=>{
            const id = btn.getAttribute('data-id');
            const doc = await db.collection('listings').doc(id).get();
            if(!doc.exists) return;
            openEdit({ id, ...doc.data() });
          });
        });

        wrap.querySelectorAll('.row-del').forEach(btn=>{
          btn.addEventListener('click', async ()=>{
            const id = btn.getAttribute('data-id');
            if(!confirm('ยืนยันลบ #' + id + ' ?')) return;
            try{
              await db.collection('listings').doc(id).delete();
              await renderTable();
            }catch(err){
              console.error(err);
              if(String(err).includes('Missing or insufficient permissions')) return rulesHint('ลบประกาศ');
              alert('ลบไม่สำเร็จ');
            }
          });
        });
      }
    }

    await renderTable();
  }

  (function(){ const y = byId('year'); if(y) y.textContent = new Date().getFullYear(); })();
});
