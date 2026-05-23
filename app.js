/* ============================================================================
   ครูไลลาขายบ้านและที่ดิน — app.js (upgraded)
   - Firebase Auth (admin), Firestore (data), Google Drive via Apps Script (images)
   - Safe rendering (no innerHTML with user data)
   - Hash router for deep linking (#/listing/:id)
   - Real-time updates (onSnapshot)
   - Marker clustering
   - Search/filter/sort, mortgage calculator, contact buttons
============================================================================ */

(function(){
  'use strict';

  /* =========================================================================
     0) Tiny utilities
  ========================================================================= */
  const byId = (id) => document.getElementById(id);
  const $$ = (sel, root=document) => Array.from(root.querySelectorAll(sel));
  const create = (tag, props={}, children=[]) => {
    const el = document.createElement(tag);
    Object.entries(props).forEach(([k,v]) => {
      if (k === 'class') el.className = v;
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === 'text') el.textContent = v;
      else if (k === 'html') {/* never used */}
      else if (v != null) el.setAttribute(k, v);
    });
    (Array.isArray(children) ? children : [children]).forEach(c => {
      if (c == null) return;
      el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    });
    return el;
  };

  /* =========================================================================
     1) Security helpers — escape user content, validate URLs
  ========================================================================= */
  function escapeHTML(s){
    return String(s ?? '').replace(/[&<>"']/g, c => ({
      '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
    }[c]));
  }
  /** Return URL only if it has http(s)/tel/mailto/line scheme. Block javascript:, data:, etc. */
  function safeUrl(u){
    if (!u) return '';
    const s = String(u).trim();
    if (/^(https?:|tel:|mailto:|line:)/i.test(s)) return s;
    if (/^\/\//.test(s)) return 'https:' + s;
    return '';
  }
  function safePhoneTel(phone){
    const digits = String(phone||'').replace(/[^\d+]/g,'');
    return digits ? 'tel:' + digits : '';
  }

  /* =========================================================================
     2) Format helpers
  ========================================================================= */
  const baht = (n) => (n!=='' && n!=null && !isNaN(+n)) ? Number(n).toLocaleString('th-TH') + ' บาท' : '-';
  const num  = (v) => (v===''||v==null||isNaN(+v)) ? '' : Number(v);
  const mapLink = (lat,lng)=> `https://www.google.com/maps?q=${encodeURIComponent(lat+','+lng)}`;
  const parseGmapLink = (url)=>{
    try{
      const s = decodeURIComponent((url||'').trim());
      const at = s.match(/@(-?\d+(\.\d+)?),\s*(-?\d+(\.\d+)?)/);
      if(at) return {lat:+at[1], lng:+at[3]};
      const q = s.match(/[?&]q=([-0-9.,\s]+)/);
      if(q){ const p = q[1].split(',').map(x=>+x.trim()); if(p.length>=2 && !isNaN(p[0]) && !isNaN(p[1])) return {lat:p[0], lng:p[1]}; }
      const simple = s.match(/(-?\d+(\.\d+)?),\s*(-?\d+(\.\d+)?)/);
      if(simple) return {lat:+simple[1], lng:+simple[3]};
    }catch{}
    return null;
  };

  /* =========================================================================
     3) Image URL normalisation (Google Drive)
  ========================================================================= */
  function normalizeDriveImageURL(u){
    if (!u) return '';
    try{
      if (u.includes('uc?')) {
        const id = new URL(u).searchParams.get('id');
        if (id) return `https://lh3.googleusercontent.com/d/${id}=s1200`;
      }
      if (u.includes('/open?')) {
        const id = new URL(u).searchParams.get('id');
        if (id) return `https://lh3.googleusercontent.com/d/${id}=s1200`;
      }
      const m = u.match(/\/file\/d\/([^/]+)/);
      if (m && m[1]) return `https://lh3.googleusercontent.com/d/${m[1]}=s1200`;
    } catch{}
    return u;
  }
  function getImageURLs(it){
    if (Array.isArray(it.imageObjs)) return it.imageObjs.map(o => normalizeDriveImageURL(o.url)).filter(Boolean);
    if (Array.isArray(it.imageURLs)) return it.imageURLs.map(u => normalizeDriveImageURL(u)).filter(Boolean);
    return [];
  }

  /* =========================================================================
     4) Toast (no more browser alert)
  ========================================================================= */
  function toast(msg, type='info', timeout=2800){
    const wrap = byId('toastWrap');
    if (!wrap){ console.log('[toast]', msg); return; }
    const t = create('div', { class:'toast ' + type, text: String(msg||'') });
    wrap.appendChild(t);
    setTimeout(()=>{ t.style.opacity='0'; t.style.transform='translateY(8px)'; t.style.transition='all .25s ease'; }, timeout-250);
    setTimeout(()=> t.remove(), timeout);
  }
  function confirmDialog(msg){ return window.confirm(msg); }

  /* =========================================================================
     5) Firebase init
  ========================================================================= */
  let db, auth;
  try{
    if (!window.firebaseConfig) console.warn('Missing window.firebaseConfig');
    if (!firebase.apps?.length) firebase.initializeApp(window.firebaseConfig || {});
    db = firebase.firestore();
    if (firebase.auth) auth = firebase.auth();
  }catch(e){
    console.error('Firebase init error:', e);
  }

  const GAS_UPLOAD_URL  = (window.GAS_UPLOAD_URL || '').trim();
  const GAS_SHARED_TOKEN = (window.GAS_SHARED_TOKEN || '').trim();

  function rulesHint(label='บันทึก/แก้ไข'){
    toast('Firestore: สิทธิ์ไม่พอ — ตรวจ Auth/Rules อีกครั้ง (' + label + ')', 'error', 5000);
    console.warn(`Firestore permission denied for "${label}". Make sure user is signed in AND Rules allow write for request.auth != null`);
  }

  /* =========================================================================
     6) Image compress + Drive upload/delete
  ========================================================================= */
  function compressImageToDataURL(file, max=1280, quality=0.82){
    return new Promise((resolve,reject)=>{
      const img = new Image(), fr = new FileReader();
      fr.onload = ()=> { img.src = fr.result; };
      fr.onerror = reject;
      img.onload = ()=>{
        const long = Math.max(img.width, img.height);
        const scale = Math.min(1, max/long);
        const w = Math.round(img.width * scale), h = Math.round(img.height * scale);
        const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
        cv.getContext('2d').drawImage(img,0,0,w,h);
        cv.toBlob(b=>{
          const fr2 = new FileReader();
          fr2.onload = ()=> resolve(fr2.result);
          fr2.onerror = reject;
          fr2.readAsDataURL(b);
        }, 'image/jpeg', quality);
      };
      img.onerror = reject;
      fr.readAsDataURL(file);
    });
  }
  async function getAuthToken(){
    try{ return auth?.currentUser ? await auth.currentUser.getIdToken() : ''; }
    catch{ return ''; }
  }
  async function uploadToDrive(files){
    if (!GAS_UPLOAD_URL) throw new Error('GAS_UPLOAD_URL is not set');
    const list = [];
    for (let i=0;i<files.length;i++){
      const dataURL = await compressImageToDataURL(files[i]);
      list.push({ name: files[i].name || `img_${Date.now()}_${i}.jpg`, dataURL });
    }
    const idToken = await getAuthToken();
    const res = await fetch(GAS_UPLOAD_URL, {
      method:'POST',
      headers:{ 'Content-Type':'text/plain;charset=utf-8' },
      body: JSON.stringify({ action:'upload', files:list, token: GAS_SHARED_TOKEN, idToken })
    });
    const json = await res.json();
    if (!json.ok) throw new Error(json.error || 'Upload failed');
    return json.items;
  }
  async function deleteDriveFiles(ids){
    if (!GAS_UPLOAD_URL) throw new Error('GAS_UPLOAD_URL is not set');
    const idToken = await getAuthToken();
    const res = await fetch(GAS_UPLOAD_URL, {
      method:'POST',
      headers:{ 'Content-Type':'text/plain;charset=utf-8' },
      body: JSON.stringify({ action:'delete', ids, token: GAS_SHARED_TOKEN, idToken })
    });
    const json = await res.json();
    if (!json.ok) throw new Error(json.error || 'Delete failed');
    return json;
  }

  /* =========================================================================
     7) Site settings (phone, LINE, etc.) — read once, reactive on admin
  ========================================================================= */
  let siteSettings = {};
  async function loadSiteSettings(){
    try{
      const doc = await db.collection('meta').doc('site').get();
      siteSettings = doc.exists ? (doc.data() || {}) : {};
    }catch(e){ console.warn('loadSiteSettings:', e); }
    return siteSettings;
  }

  /* =========================================================================
     8) Common: types loader
  ========================================================================= */
  async function loadTypes(){
    try{
      const doc = await db.collection('meta').doc('types').get();
      return (doc.exists && Array.isArray(doc.data().list)) ? doc.data().list : ['บ้าน','ที่ดิน'];
    }catch{ return ['บ้าน','ที่ดิน']; }
  }
  function renderTypeOptions(selects, types, includeAll=false){
    (selects||[]).forEach(sel=>{
      if (!sel) return;
      const keep = sel.value;
      const all = includeAll ? '<option value="">ทั้งหมด</option>' : '';
      sel.innerHTML = all + types.map(t => `<option value="${escapeHTML(t)}">${escapeHTML(t)}</option>`).join('');
      if (keep && types.includes(keep)) sel.value = keep;
    });
  }

  /* =========================================================================
     9) Status / mode helpers
  ========================================================================= */
  const STATUS_LABEL = { available:'เปิดขาย', reserved:'จองแล้ว', sold:'ขายแล้ว' };
  const MODE_LABEL   = { sale:'ขาย', rent:'เช่า' };

  function badgeFor(it){
    const wrap = create('span', { class:'row', style:{ gap:'4px' } });
    const mode = it.listingMode === 'rent' ? 'rent' : 'sale';
    wrap.appendChild(create('span', { class:'badge mode-'+mode, text: MODE_LABEL[mode] }));
    const st = it.status || 'available';
    wrap.appendChild(create('span', { class:'badge '+st, text: STATUS_LABEL[st] || STATUS_LABEL.available }));
    return wrap;
  }

  /* =========================================================================
     10) Year footer
  ========================================================================= */
  (function setYear(){
    const y = byId('year'); if (y) y.textContent = new Date().getFullYear();
  })();


  /* =====================================================================
     ╔═══════════════════════════════════════════════════════════════════╗
     ║                    PUBLIC INDEX PAGE                              ║
     ╚═══════════════════════════════════════════════════════════════════╝
  ===================================================================== */
  window.addEventListener('DOMContentLoaded', () => {
    if (byId('map') && db) initIndex();
    if (byId('loginBox') && db) initAdminAuth();
  });

  async function initIndex(){
    /* Map */
    const map = L.map('map', { scrollWheelZoom:true }).setView([13.736717,100.523186], 6);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom:19, attribution:'© OpenStreetMap'
    }).addTo(map);
    const cluster = (typeof L.markerClusterGroup === 'function')
      ? L.markerClusterGroup({ showCoverageOnHover:false, maxClusterRadius:50 })
      : L.layerGroup();
    map.addLayer(cluster);

    /* Refs */
    const listEl  = byId('listings');
    const skel    = byId('skelList');
    const detail  = byId('detailPanel');
    const fltType = byId('fltType'), fltMin = byId('fltMin'), fltMax = byId('fltMax');
    const fltMode = byId('fltMode'), fltStatus = byId('fltStatus'), fltSort = byId('fltSort');
    const fltSearch = byId('fltSearch');
    const addrQuery = byId('addrQuery'), addrBtn = byId('addrSearch'), addrRes = byId('addrResults');
    const loadMoreWrap = byId('loadMoreWrap'), loadMoreBtn = byId('loadMoreBtn');

    /* Site settings → footer + topbar FB link */
    await loadSiteSettings();
    applySiteToIndex();

    /* Types */
    const types = await loadTypes();
    renderTypeOptions([fltType], types, true);

    /* Data state */
    let allItems = [];
    let visibleCount = 12;
    const PAGE = 12;

    /* Real-time listings */
    db.collection('listings').orderBy('createdAt','desc')
      .onSnapshot(snap => {
        allItems = snap.docs.map(d => ({ id:d.id, ...d.data() }));
        if (skel) skel.remove();
        renderIndex();
        // If user was on a deep-link, re-open after data loads
        applyHashRoute();
      }, err => {
        console.error('listings onSnapshot:', err);
        if (skel) skel.remove();
        if (String(err).includes('permission')) toast('อ่านข้อมูลไม่ได้ — โปรดตั้ง Firestore Rules', 'error', 5000);
        else toast('โหลดข้อมูลไม่สำเร็จ', 'error');
      });

    /* Address search (Nominatim) */
    addrBtn?.addEventListener('click', async () => {
      const q = (addrQuery?.value||'').trim();
      if (!q || !addrRes) return;
      addrRes.textContent = 'กำลังค้นหา…';
      try{
        const url = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(q)}&addressdetails=1&limit=6`;
        const r = await fetch(url, { headers:{ 'Accept':'application/json' } });
        const data = await r.json();
        addrRes.innerHTML = '';
        if (!data.length){ addrRes.textContent = 'ไม่พบผลลัพธ์'; return; }
        data.forEach(d => {
          const item = create('div', { class:'addr-item', role:'option', text: d.display_name,
            onclick: () => map.flyTo([+d.lat, +d.lon], 15, { duration:.6 })
          });
          addrRes.appendChild(item);
        });
      }catch{ addrRes.textContent = 'เกิดข้อผิดพลาดในการค้นหา'; }
    });
    addrQuery?.addEventListener('keydown', e => { if (e.key==='Enter') addrBtn?.click(); });

    /* Filters */
    function passFilter(it){
      if (fltType?.value && it.type !== fltType.value) return false;
      if (fltMode?.value && (it.listingMode || 'sale') !== fltMode.value) return false;
      if (fltStatus?.value && (it.status || 'available') !== fltStatus.value) return false;
      if (fltMin?.value && +it.price < +fltMin.value) return false;
      if (fltMax?.value && +it.price > +fltMax.value) return false;
      if (fltSearch?.value){
        const q = fltSearch.value.trim().toLowerCase();
        if (q){
          const hay = (it.title + ' ' + (it.desc||'') + ' ' + (it.type||'')).toLowerCase();
          if (!hay.includes(q)) return false;
        }
      }
      return true;
    }
    function sortItems(items){
      const s = fltSort?.value || 'new';
      if (s === 'priceAsc')  return items.slice().sort((a,b)=> (+a.price||0) - (+b.price||0));
      if (s === 'priceDesc') return items.slice().sort((a,b)=> (+b.price||0) - (+a.price||0));
      return items; // createdAt desc from query
    }

    /* Marker icon */
    function iconThumb(url, isSold){
      const cls = 'thumb-marker' + (isSold ? ' is-sold' : '');
      const inner = url
        ? `<img src="${escapeHTML(url)}" alt="" loading="lazy">`
        : `<span class="pin-fallback">🏠</span>`;
      return L.divIcon({
        html:`<div class="${cls}">${inner}</div>`,
        className:'', iconSize:[52,52], iconAnchor:[26,26], popupAnchor:[0,-28]
      });
    }

    /* Card */
    function buildCard(it){
      const urls = getImageURLs(it);
      const firstURL = urls[0] || '';
      const isSold = (it.status === 'sold');
      const isRent = (it.listingMode === 'rent');

      const card = create('div', { class:'card-item glass' + (isSold ? ' is-sold' : '') });

      const img = create('img', {
        alt: it.title || '',
        loading:'lazy',
        src: firstURL || 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="120" height="120"><rect fill="%23eaf2ff" width="120" height="120"/><text x="50%" y="55%" text-anchor="middle" font-size="32" fill="%23b6c8e6">🏠</text></svg>'
      });
      card.appendChild(img);

      const content = create('div', { class:'content' });
      content.appendChild(create('div', { class:'title', text: it.title || '-' }));
      const meta = create('div', { class:'meta' });
      meta.appendChild(badgeFor(it));
      content.appendChild(meta);

      const price = create('div', { class:'price-plain' + (isRent ? ' rent':'') });
      price.appendChild(document.createTextNode(baht(it.price)));
      if (it.priceUnit) price.appendChild(create('span', { class:'unit', text:'· '+it.priceUnit }));
      content.appendChild(price);

      // quick spec line
      const specBits = [];
      if (it.bedrooms)   specBits.push(`🛏 ${it.bedrooms}`);
      if (it.bathrooms)  specBits.push(`🚿 ${it.bathrooms}`);
      if (it.usableArea) specBits.push(`📐 ${it.usableArea} ตร.ม.`);
      if (it.landSize)   specBits.push(`🌳 ${it.landSize} ตร.วา`);
      if (specBits.length){
        content.appendChild(create('div', { class:'small', text: specBits.join('  ·  ') }));
      }

      card.appendChild(content);
      card.addEventListener('click', () => {
        navigateTo(`#/listing/${encodeURIComponent(it.id)}`);
        if (it.lat && it.lng) map.flyTo([it.lat, it.lng], 15, { duration:.6 });
      });

      return card;
    }

    /* Gallery (inside detail) */
    function mountGallery(container, urls){
      container.innerHTML = '';
      if (!urls.length){
        container.appendChild(create('div', { class:'gallery-empty', text:'ไม่มีรูปภาพ' }));
        return;
      }
      let current = 0;
      const wrap = create('div', { class:'gallery-wrap' });
      const main = create('img', { class:'gallery-main', alt:'', src: urls[0], loading:'lazy' });
      main.addEventListener('click', () => openLightbox(urls, current));
      wrap.appendChild(main);
      container.appendChild(wrap);

      const strip = create('div', { class:'detail-gallery' });
      urls.forEach((u,i) => {
        const t = create('img', { src:u, alt:'', loading:'lazy' });
        if (i===0) t.classList.add('active');
        t.addEventListener('click', () => {
          current = i;
          main.src = urls[i];
          strip.querySelectorAll('img').forEach(x => x.classList.remove('active'));
          t.classList.add('active');
        });
        strip.appendChild(t);
      });
      container.appendChild(strip);
    }

    /* Contact bar — from site settings */
    function contactBarFor(it){
      const bar = create('div', { class:'contact-bar' });
      const phone = siteSettings.phone;
      const lineUrl = safeUrl(siteSettings.lineUrl);
      const fbPage = safeUrl(it.fbUrl || siteSettings.facebookPage);
      const msgr = safeUrl(siteSettings.messengerUrl);

      if (phone){
        const a = create('a', { class:'btn btn-call', href: safePhoneTel(phone), rel:'noopener', text:'📞 โทร' });
        bar.appendChild(a);
      }
      if (lineUrl){
        const a = create('a', { class:'btn btn-line', href: lineUrl, target:'_blank', rel:'noopener', text:'💬 LINE' });
        bar.appendChild(a);
      }
      if (msgr){
        const a = create('a', { class:'btn btn-msgr', href: msgr, target:'_blank', rel:'noopener', text:'✉️ Messenger' });
        bar.appendChild(a);
      }
      if (fbPage){
        const a = create('a', { class:'btn btn-fb', href: fbPage, target:'_blank', rel:'noopener', text:'📘 Facebook' });
        bar.appendChild(a);
      }
      return bar;
    }

    /* Spec grid */
    function specGridFor(it){
      const cells = [];
      if (it.bedrooms)   cells.push({ v: it.bedrooms,   l:'ห้องนอน' });
      if (it.bathrooms)  cells.push({ v: it.bathrooms,  l:'ห้องน้ำ' });
      if (it.usableArea) cells.push({ v: it.usableArea,l:'ตร.ม.' });
      if (it.landSize)   cells.push({ v: it.landSize,   l:'ตร.วา' });
      if (it.parking)    cells.push({ v: it.parking,    l:'จอดรถ' });
      if (!cells.length) return null;
      const wrap = create('div', { class:'spec-grid' });
      cells.forEach(c => {
        const cell = create('div', { class:'spec-cell' });
        cell.appendChild(create('div', { class:'v', text: String(c.v) }));
        cell.appendChild(create('div', { class:'l', text: c.l }));
        wrap.appendChild(cell);
      });
      return wrap;
    }

    /* Detail panel (open / close) */
    function openDetail(it){
      const col = detail?.parentElement;
      if (!detail || !col) return;
      detail.innerHTML = '';

      const head = create('div', { class:'detail-head' });
      head.appendChild(create('b', { text: it.title || '-' }));
      head.appendChild(create('button', { class:'btn btn-ghost', text:'✕', 'aria-label':'ปิด',
        onclick: closeDetail
      }));
      detail.appendChild(head);

      const body = create('div', { class:'detail-body' });

      // badges line
      body.appendChild(badgeFor(it));

      // gallery
      const galWrap = create('div');
      mountGallery(galWrap, getImageURLs(it));
      body.appendChild(galWrap);

      // price
      const isRent = it.listingMode === 'rent';
      const price = create('div', { class:'price-plain' + (isRent?' rent':'') });
      price.appendChild(document.createTextNode(baht(it.price)));
      if (it.priceUnit) price.appendChild(create('span', { class:'unit', text:'· '+it.priceUnit }));
      body.appendChild(price);

      // type line
      body.appendChild(create('div', { class:'small', text: (it.type||'-') }));

      // spec grid
      const sg = specGridFor(it); if (sg) body.appendChild(sg);

      // description
      if (it.desc){
        const p = create('div', { style:{ whiteSpace:'pre-wrap', lineHeight:1.55 } });
        p.textContent = it.desc;
        body.appendChild(p);
      }

      // actions: map + mortgage
      const actions = create('div', { class:'detail-actions' });
      if (it.lat && it.lng){
        actions.appendChild(create('a', { class:'btn btn-secondary',
          href: mapLink(it.lat,it.lng), target:'_blank', rel:'noopener', text:'🗺️ เปิด Google Maps' }));
      }
      if (it.price && !isRent){
        actions.appendChild(create('button', { class:'btn btn-secondary', text:'🧮 คำนวณค่างวด',
          onclick: () => openLoan(+it.price)
        }));
      }
      // copy link
      actions.appendChild(create('button', { class:'btn btn-ghost', text:'🔗 คัดลอกลิงก์',
        onclick: () => {
          const url = location.origin + location.pathname + '#/listing/' + encodeURIComponent(it.id);
          navigator.clipboard?.writeText(url).then(()=> toast('คัดลอกลิงก์แล้ว','success'),
                                                     ()=> toast('คัดลอกไม่สำเร็จ','error'));
        }
      }));
      body.appendChild(actions);

      // contact bar
      body.appendChild(contactBarFor(it));

      detail.appendChild(body);
      detail.hidden = false;
      col.classList.add('has-detail');

      // SEO: update title + OG image when opening
      document.title = `${it.title || 'ประกาศ'} | ครูไลลาขายบ้านและที่ดิน`;
      const first = getImageURLs(it)[0];
      const og = byId('ogImage'); if (og && first) og.setAttribute('content', first);
    }
    function closeDetail(){
      const col = detail?.parentElement;
      if (!detail || !col) return;
      detail.hidden = true;
      detail.innerHTML = '';
      col.classList.remove('has-detail');
      document.title = 'ครูไลลาขายบ้านและที่ดิน — รวมประกาศบ้าน ที่ดิน คอนโด';
      if (location.hash.startsWith('#/listing/')) history.replaceState(null,'','#/');
    }
    detail?.parentElement?.addEventListener('click', (e) => {
      // click on backdrop closes
      if (e.target === detail.parentElement) closeDetail();
    });

    /* Render listings */
    function renderIndex(){
      const filtered = sortItems(allItems.filter(passFilter));
      cluster.clearLayers();
      listEl.innerHTML = '';

      const slice = filtered.slice(0, visibleCount);
      const bounds = [];
      slice.forEach(it => {
        const urls = getImageURLs(it);
        const firstURL = urls[0] || '';
        if (it.lat && it.lng){
          const mk = L.marker([it.lat, it.lng], { icon: iconThumb(firstURL, it.status==='sold') });
          if (firstURL){
            mk.bindTooltip(
              `<div class="tt-title">${escapeHTML(it.title||'')}</div><img src="${escapeHTML(firstURL)}" alt="" loading="lazy">`,
              { direction:'top', offset:[0,-30], sticky:true, opacity:1, className:'thumb-tip' }
            );
          }
          mk.on('click', () => navigateTo(`#/listing/${encodeURIComponent(it.id)}`));
          cluster.addLayer(mk);
          bounds.push([it.lat, it.lng]);
        }
        listEl.appendChild(buildCard(it));
      });

      if (bounds.length){
        try { map.fitBounds(bounds, { padding:[20,20], maxZoom:15 }); } catch{}
      }

      // empty state
      if (!filtered.length){
        listEl.appendChild(create('div', { class:'card glass', text:'— ไม่พบประกาศที่ตรงตามเงื่อนไข —' }));
      }
      // load more
      if (filtered.length > slice.length){
        loadMoreWrap.hidden = false;
      } else {
        loadMoreWrap.hidden = true;
      }
    }

    /* Filter events */
    [fltType, fltMode, fltStatus, fltSort].forEach(el => el?.addEventListener('change', () => { visibleCount = PAGE; renderIndex(); }));
    [fltMin, fltMax, fltSearch].forEach(el => el?.addEventListener('input', debounce(() => { visibleCount = PAGE; renderIndex(); }, 200)));
    byId('applyFilter')?.addEventListener('click', () => { visibleCount = PAGE; renderIndex(); });
    byId('clearFilter')?.addEventListener('click', () => {
      [fltType, fltMin, fltMax, fltMode, fltStatus, fltSearch].forEach(el => { if (el) el.value=''; });
      if (fltSort) fltSort.value = 'new';
      visibleCount = PAGE;
      renderIndex();
    });
    loadMoreBtn?.addEventListener('click', () => { visibleCount += PAGE; renderIndex(); });

    /* Hash router */
    function navigateTo(hash){ if (location.hash !== hash) location.hash = hash; else applyHashRoute(); }
    function applyHashRoute(){
      const h = location.hash || '';
      const m = h.match(/^#\/listing\/(.+)$/);
      if (m){
        const id = decodeURIComponent(m[1]);
        const it = allItems.find(x => x.id === id);
        if (it) openDetail(it);
      } else {
        closeDetail();
      }
    }
    window.addEventListener('hashchange', applyHashRoute);

    /* Apply site settings to topbar/footer */
    function applySiteToIndex(){
      const fb = safeUrl(siteSettings.facebookPage);
      const navFb = byId('navFacebook');
      if (navFb){
        if (fb){
          navFb.href = fb;
          navFb.hidden = false;
        } else {
          navFb.hidden = true;
        }
      }
      const fc = byId('footerContact');
      if (fc){
        fc.innerHTML = '';
        if (siteSettings.phone){
          fc.appendChild(create('a', { href: safePhoneTel(siteSettings.phone), text:'📞 '+siteSettings.phone }));
        }
        if (safeUrl(siteSettings.lineUrl)){
          fc.appendChild(create('a', { href: safeUrl(siteSettings.lineUrl), target:'_blank', rel:'noopener', text:'💬 LINE' }));
        }
        if (fb){
          fc.appendChild(create('a', { href: fb, target:'_blank', rel:'noopener', text:'📘 Facebook' }));
        }
      }
    }

    /* Lightbox */
    setupLightbox();
    /* Mortgage modal */
    setupLoanModal();
  }

  /* =========================================================================
     11) Lightbox controller (works on both pages)
  ========================================================================= */
  let _lbState = { urls:[], idx:0 };
  function setupLightbox(){
    const lb = byId('lightbox');
    const img = byId('lightboxImg');
    const ctr = byId('lbCounter');
    if (!lb || !img) return;
    byId('lbClose')?.addEventListener('click', closeLightbox);
    byId('lbPrev')?.addEventListener('click', e => { e.stopPropagation(); step(-1); });
    byId('lbNext')?.addEventListener('click', e => { e.stopPropagation(); step(+1); });
    lb.addEventListener('click', e => { if (e.target === lb) closeLightbox(); });
    document.addEventListener('keydown', e => {
      if (lb.hidden) return;
      if (e.key === 'Escape') closeLightbox();
      else if (e.key === 'ArrowLeft') step(-1);
      else if (e.key === 'ArrowRight') step(+1);
    });
    function step(d){
      if (!_lbState.urls.length) return;
      _lbState.idx = (_lbState.idx + d + _lbState.urls.length) % _lbState.urls.length;
      img.src = _lbState.urls[_lbState.idx];
      if (ctr) ctr.textContent = (_lbState.idx+1) + ' / ' + _lbState.urls.length;
    }
  }
  function openLightbox(urls, startIdx=0){
    const lb = byId('lightbox');
    const img = byId('lightboxImg');
    const ctr = byId('lbCounter');
    if (!lb || !img) return;
    _lbState.urls = Array.isArray(urls) ? urls : [urls];
    _lbState.idx  = Math.max(0, Math.min(startIdx, _lbState.urls.length-1));
    img.src = _lbState.urls[_lbState.idx] || '';
    if (ctr) ctr.textContent = _lbState.urls.length>1 ? (_lbState.idx+1)+' / '+_lbState.urls.length : '';
    lb.hidden = false;
  }
  function closeLightbox(){
    const lb = byId('lightbox'); if (lb) lb.hidden = true;
  }

  /* =========================================================================
     12) Mortgage modal
  ========================================================================= */
  function setupLoanModal(){
    const m = byId('loanModal'); if (!m) return;
    byId('loanClose')?.addEventListener('click', () => m.hidden = true);
    m.addEventListener('click', e => { if (e.target === m) m.hidden = true; });
    ['loanPrice','loanDown','loanRate','loanYears'].forEach(id => {
      byId(id)?.addEventListener('input', recalcLoan);
    });
  }
  function openLoan(price){
    const m = byId('loanModal'); if (!m) return;
    byId('loanPrice').value = price || '';
    byId('loanDown').value  = byId('loanDown').value || 20;
    byId('loanRate').value  = byId('loanRate').value || 6.5;
    byId('loanYears').value = byId('loanYears').value || 30;
    m.hidden = false;
    recalcLoan();
  }
  function recalcLoan(){
    const price = +byId('loanPrice').value || 0;
    const downPct = +byId('loanDown').value || 0;
    const rate = +byId('loanRate').value || 0;
    const years = +byId('loanYears').value || 0;
    const out = byId('loanResult'); if (!out) return;
    if (!price || !years){
      out.innerHTML = '<div class="small muted">กรอกราคาและระยะเวลาเพื่อคำนวณ</div>';
      return;
    }
    const loan = price * (1 - downPct/100);
    const r = (rate/100)/12;
    const n = years*12;
    const m = r === 0 ? loan/n : loan * r / (1 - Math.pow(1+r, -n));
    const total = m*n;
    const interest = total - loan;
    out.innerHTML = '';
    const big = create('div', { class:'big', text:`ค่างวด ~ ${Math.round(m).toLocaleString('th-TH')} บาท/เดือน` });
    out.appendChild(big);
    out.appendChild(create('div', { class:'small', text:
      `วงเงินกู้: ${Math.round(loan).toLocaleString('th-TH')} บาท · ดอกเบี้ยรวมตลอดสัญญา ~ ${Math.round(interest).toLocaleString('th-TH')} บาท · รวมจ่าย ~ ${Math.round(total).toLocaleString('th-TH')} บาท`
    }));
  }

  /* =========================================================================
     13) Debounce
  ========================================================================= */
  function debounce(fn, ms){
    let t; return function(...args){ clearTimeout(t); t = setTimeout(()=> fn.apply(this,args), ms); };
  }


  /* =====================================================================
     ╔═══════════════════════════════════════════════════════════════════╗
     ║                       ADMIN PAGE                                  ║
     ╚═══════════════════════════════════════════════════════════════════╝
  ===================================================================== */
  function initAdminAuth(){
    const loginBox = byId('loginBox'), adminBox = byId('adminBox');
    const emailEl = byId('loginEmail'), passEl = byId('loginPass');

    byId('loginBtn')?.addEventListener('click', async () => {
      const email = (emailEl?.value||'').trim();
      const pass  = (passEl?.value||'');
      if (!email || !pass) return toast('กรุณากรอกอีเมลและรหัสผ่าน','warn');
      try{
        await auth.signInWithEmailAndPassword(email, pass);
      }catch(err){
        console.error(err);
        toast('เข้าสู่ระบบไม่สำเร็จ: ' + (err.code || err.message), 'error', 4000);
      }
    });
    passEl?.addEventListener('keydown', e => { if (e.key==='Enter') byId('loginBtn').click(); });

    byId('forgotBtn')?.addEventListener('click', async () => {
      const email = (emailEl?.value||'').trim();
      if (!email) return toast('กรอกอีเมลก่อน','warn');
      try{
        await auth.sendPasswordResetEmail(email);
        toast('ส่งอีเมลรีเซ็ตรหัสผ่านแล้ว','success');
      }catch(err){ toast(err.message||'ส่งอีเมลไม่สำเร็จ','error'); }
    });

    byId('logoutBtn')?.addEventListener('click', () => auth.signOut());

    auth.onAuthStateChanged(user => {
      const who = byId('whoAmI');
      const logout = byId('logoutBtn');
      if (user){
        loginBox.hidden = true;
        adminBox.hidden = false;
        if (who){ who.hidden = false; who.textContent = user.email; }
        if (logout) logout.hidden = false;
        initAdmin();
      } else {
        loginBox.hidden = false;
        adminBox.hidden = true;
        if (who) who.hidden = true;
        if (logout) logout.hidden = true;
      }
    });
  }

  let _adminInited = false;
  async function initAdmin(){
    if (_adminInited) return;
    _adminInited = true;

    /* Refs — form */
    const f_title=byId('f_title'), f_type=byId('f_type'),
          f_listingMode=byId('f_listingMode'), f_status=byId('f_status'),
          f_price=byId('f_price'), f_priceUnit=byId('f_priceUnit'),
          f_bedrooms=byId('f_bedrooms'), f_bathrooms=byId('f_bathrooms'),
          f_usableArea=byId('f_usableArea'), f_landSize=byId('f_landSize'),
          f_parking=byId('f_parking'),
          f_desc=byId('f_desc'), f_fbUrl=byId('f_fbUrl'),
          f_gmap=byId('f_gmap'), f_lat=byId('f_lat'), f_lng=byId('f_lng'),
          f_imgs=byId('f_imgs'), imgsPrev=byId('imgsPrev');
    const saveBtn=byId('saveBtn'), exportBtn=byId('exportBtn'),
          importBtn=byId('importBtn'), importFile=byId('importFile');

    /* Refs — edit */
    const editModal=byId('editModal'), closeEdit=byId('closeEdit');
    const e_id=byId('e_id'), e_title=byId('e_title'), e_type=byId('e_type'),
          e_listingMode=byId('e_listingMode'), e_status=byId('e_status'),
          e_price=byId('e_price'), e_priceUnit=byId('e_priceUnit'),
          e_bedrooms=byId('e_bedrooms'), e_bathrooms=byId('e_bathrooms'),
          e_usableArea=byId('e_usableArea'), e_landSize=byId('e_landSize'),
          e_parking=byId('e_parking'),
          e_desc=byId('e_desc'), e_fbUrl=byId('e_fbUrl'),
          e_gmap=byId('e_gmap'), e_lat=byId('e_lat'), e_lng=byId('e_lng'),
          e_imgs=byId('e_imgs'), e_imgsPrev=byId('e_imgsPrev'),
          e_updateBtn=byId('e_updateBtn'), e_deleteBtn=byId('e_deleteBtn'),
          e_imgsList=byId('e_imgsList');

    /* Map (admin overview) */
    const allMap = L.map('allMap').setView([13.736717,100.523186], 6);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:19}).addTo(allMap);
    const allMarkers = (typeof L.markerClusterGroup === 'function')
      ? L.markerClusterGroup({ showCoverageOnHover:false })
      : L.layerGroup();
    allMap.addLayer(allMarkers);
    const iconThumbAdmin = (url, isSold) => L.divIcon({
      html: `<div class="thumb-marker${isSold?' is-sold':''}">${url?`<img src="${escapeHTML(url)}" alt="" loading="lazy">`:'<span class="pin-fallback">🏠</span>'}</div>`,
      className:'', iconSize:[52,52], iconAnchor:[26,26]
    });

    /* Parse gmap links */
    f_gmap?.addEventListener('change', () => { const g=parseGmapLink(f_gmap.value); if(g){ f_lat.value=g.lat; f_lng.value=g.lng; } });
    e_gmap?.addEventListener('change', () => { const g=parseGmapLink(e_gmap.value); if(g){ e_lat.value=g.lat; e_lng.value=g.lng; } });

    /* Site settings UI */
    await loadSiteSettings();
    byId('s_phone').value = siteSettings.phone || '';
    byId('s_lineId').value = siteSettings.lineId || '';
    byId('s_lineUrl').value = siteSettings.lineUrl || '';
    byId('s_facebookPage').value = siteSettings.facebookPage || '';
    byId('s_messengerUrl').value = siteSettings.messengerUrl || '';
    byId('s_about').value = siteSettings.aboutText || '';
    byId('saveSiteBtn')?.addEventListener('click', async () => {
      try{
        const payload = {
          phone: (byId('s_phone').value||'').trim(),
          lineId: (byId('s_lineId').value||'').trim(),
          lineUrl: (byId('s_lineUrl').value||'').trim(),
          facebookPage: (byId('s_facebookPage').value||'').trim(),
          messengerUrl: (byId('s_messengerUrl').value||'').trim(),
          aboutText: (byId('s_about').value||'').trim(),
          updatedAt: firebase.firestore.FieldValue.serverTimestamp()
        };
        await db.collection('meta').doc('site').set(payload, { merge:true });
        siteSettings = payload;
        toast('บันทึกการตั้งค่าแล้ว','success');
      }catch(err){
        console.error(err);
        if (String(err).includes('permission')) return rulesHint('บันทึกการตั้งค่า');
        toast('บันทึกไม่สำเร็จ','error');
      }
    });

    /* Types */
    async function refreshTypesUI(){
      const types = await loadTypes();
      renderTypeOptions([f_type, e_type], types);
      const chips = byId('typeChips'); if (!chips) return;
      chips.innerHTML = '';
      types.forEach(t => {
        const chip = create('span', { class:'chip', text:t });
        chip.appendChild(create('button', { class:'del', 'aria-label':'ลบ', text:'✕',
          onclick: async () => {
            if (!confirmDialog('ลบประเภท "'+t+'" ?')) return;
            try{
              const cur = await loadTypes();
              const next = cur.filter(x => x !== t);
              await db.collection('meta').doc('types').set({ list: next }, { merge:true });
              await refreshTypesUI();
              toast('ลบประเภทแล้ว','success');
            }catch(err){
              console.error(err);
              if (String(err).includes('permission')) return rulesHint('ลบประเภท');
              toast('ลบไม่สำเร็จ','error');
            }
          }
        }));
        chips.appendChild(chip);
      });
    }
    byId('typeAddBtn')?.addEventListener('click', async () => {
      const v = (byId('typeInput').value||'').trim();
      if (!v) return;
      try{
        const cur = await loadTypes();
        if (cur.includes(v)){ toast('มีประเภทนี้แล้ว','warn'); return; }
        cur.push(v);
        await db.collection('meta').doc('types').set({ list: cur }, { merge:true });
        byId('typeInput').value = '';
        await refreshTypesUI();
        toast('เพิ่มแล้ว','success');
      }catch(err){
        console.error(err);
        if (String(err).includes('permission')) return rulesHint('เพิ่มประเภท');
        toast('เพิ่มไม่สำเร็จ','error');
      }
    });
    await refreshTypesUI();

    /* New image previews */
    let add_files = [];
    f_imgs?.addEventListener('change', () => {
      add_files = Array.from(f_imgs.files||[]).slice(0,12);
      imgsPrev.innerHTML = '';
      add_files.forEach(file => {
        const im = new Image(); im.src = URL.createObjectURL(file); imgsPrev.appendChild(im);
      });
    });

    /* Save (create) */
    saveBtn?.addEventListener('click', async () => {
      const title = (f_title?.value||'').trim();
      if (!title) return toast('กรอกหัวข้อก่อน','warn');
      saveBtn.disabled = true;
      try{
        const meta = {
          title,
          type: f_type?.value || 'บ้าน',
          listingMode: f_listingMode?.value || 'sale',
          status: f_status?.value || 'available',
          price: num(f_price?.value),
          priceUnit: (f_priceUnit?.value||'').trim(),
          bedrooms: num(f_bedrooms?.value),
          bathrooms: num(f_bathrooms?.value),
          usableArea: num(f_usableArea?.value),
          landSize: num(f_landSize?.value),
          parking: num(f_parking?.value),
          desc: (f_desc?.value||'').trim(),
          fbUrl: safeUrl(f_fbUrl?.value),
          lat: num(f_lat?.value),
          lng: num(f_lng?.value),
          imageObjs: [],
          createdAt: firebase.firestore.FieldValue.serverTimestamp(),
          updatedAt: firebase.firestore.FieldValue.serverTimestamp()
        };
        const docRef = await db.collection('listings').add(meta);

        if (add_files.length){
          toast('กำลังอัปโหลดรูป…');
          const items = await uploadToDrive(add_files);
          await docRef.update({ imageObjs: items, updatedAt: firebase.firestore.FieldValue.serverTimestamp() });
        }

        byId('listingForm')?.reset();
        imgsPrev.innerHTML = '';
        add_files = [];
        toast('เพิ่มประกาศแล้ว','success');
      }catch(err){
        console.error(err);
        if (String(err).includes('permission')) return rulesHint('บันทึก');
        toast('เกิดข้อผิดพลาด: ' + (err.message||''),'error',5000);
      }finally{
        saveBtn.disabled = false;
      }
    });

    /* Export */
    exportBtn?.addEventListener('click', async () => {
      try{
        const snap = await db.collection('listings').get();
        const items = snap.docs.map(d => ({ id:d.id, ...d.data() }));
        const payload = { exportedAt:new Date().toISOString(), items };
        const blob = new Blob([JSON.stringify(payload,null,2)], { type:'application/json' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = 'listings-export.json';
        a.click();
        setTimeout(()=> URL.revokeObjectURL(a.href), 1000);
      }catch(err){
        console.error(err); toast('ส่งออกล้มเหลว','error');
      }
    });

    /* Import */
    importBtn?.addEventListener('click', () => importFile?.click());
    importFile?.addEventListener('change', () => {
      const f = importFile.files?.[0]; if (!f) return;
      if (!confirmDialog('นำเข้าจะเพิ่มประกาศใหม่ตามไฟล์ (ไม่ลบของเดิม) — ดำเนินการต่อ?')) return;
      const r = new FileReader();
      r.onload = async (e) => {
        try{
          const raw = JSON.parse(e.target.result || '{}');
          const arr = Array.isArray(raw.items) ? raw.items : [];
          for (const item of arr){
            const { id:_drop, createdAt:_c, updatedAt:_u, ...fields } = item;
            await db.collection('listings').add({
              ...fields,
              createdAt: firebase.firestore.FieldValue.serverTimestamp(),
              updatedAt: firebase.firestore.FieldValue.serverTimestamp()
            });
          }
          toast('นำเข้าเรียบร้อย','success');
        }catch(err){ console.error(err); toast('ไฟล์ไม่ถูกต้อง','error'); }
      };
      r.readAsText(f);
    });

    /* Edit modal */
    function openEdit(it){
      e_id.value = it.id;
      e_title.value = it.title || '';
      loadTypes().then(types => {
        renderTypeOptions([e_type], types);
        e_type.value = types.includes(it.type) ? it.type : (types[0] || 'บ้าน');
      });
      e_listingMode.value = it.listingMode || 'sale';
      e_status.value = it.status || 'available';
      e_price.value = (it.price==''||it.price==null)?'':it.price;
      e_priceUnit.value = it.priceUnit || '';
      e_bedrooms.value = it.bedrooms ?? '';
      e_bathrooms.value = it.bathrooms ?? '';
      e_usableArea.value = it.usableArea ?? '';
      e_landSize.value = it.landSize ?? '';
      e_parking.value = it.parking ?? '';
      e_desc.value = it.desc || '';
      e_fbUrl.value = it.fbUrl || '';
      e_lat.value = (it.lat==''||it.lat==null)?'':it.lat;
      e_lng.value = (it.lng==''||it.lng==null)?'':it.lng;
      e_gmap.value = '';

      // existing images
      const objs = Array.isArray(it.imageObjs) ? it.imageObjs
                 : (Array.isArray(it.imageURLs) ? it.imageURLs.map(u => ({ id:null, url: normalizeDriveImageURL(u) })) : []);
      e_imgsList.innerHTML = '';
      if (!objs.length){
        e_imgsList.appendChild(create('div', { class:'small muted', text:'— ไม่มีรูป —' }));
      } else {
        objs.forEach(o => {
          const u = normalizeDriveImageURL(o.url);
          const cell = create('div');
          const img = create('img', { src:u, alt:'', loading:'lazy' });
          const del = create('button', { class:'btn btn-ghost btn-danger', text:'ลบรูป' });
          del.addEventListener('click', async (ev) => {
            ev.stopPropagation();
            if (!confirmDialog('ลบรูปนี้ออก' + (o.id?' (รวมจาก Google Drive)':'') + ' ?')) return;
            try{
              if (o.id) await deleteDriveFiles([o.id]);
              const ref = db.collection('listings').doc(it.id);
              const snap = await ref.get();
              if (!snap.exists) return;
              const cur = snap.data();
              if (Array.isArray(cur.imageObjs) && cur.imageObjs.length){
                const arr = cur.imageObjs.filter(x => (x.id||'') !== (o.id||'') && normalizeDriveImageURL(x.url) !== u);
                await ref.update({ imageObjs: arr, updatedAt: firebase.firestore.FieldValue.serverTimestamp() });
              } else if (Array.isArray(cur.imageURLs)){
                const urls = cur.imageURLs.map(normalizeDriveImageURL).filter(x => x !== u);
                await ref.update({ imageURLs: urls, updatedAt: firebase.firestore.FieldValue.serverTimestamp() });
              }
              cell.remove();
              toast('ลบรูปแล้ว','success');
            }catch(err){
              console.error(err);
              if (String(err).includes('permission')) return rulesHint('ลบรูป');
              toast('ลบรูปไม่สำเร็จ: '+(err.message||''),'error',4000);
            }
          });
          cell.appendChild(img); cell.appendChild(del);
          e_imgsList.appendChild(cell);
        });
      }

      e_imgs.value = '';
      e_imgsPrev.innerHTML = '';
      editModal.hidden = false;
    }
    closeEdit?.addEventListener('click', () => editModal.hidden = true);
    editModal?.addEventListener('click', e => { if (e.target === editModal) editModal.hidden = true; });

    e_imgs?.addEventListener('change', () => {
      e_imgsPrev.innerHTML = '';
      Array.from(e_imgs.files||[]).slice(0,12).forEach(file => {
        const im = new Image(); im.src = URL.createObjectURL(file); e_imgsPrev.appendChild(im);
      });
    });

    e_updateBtn?.addEventListener('click', async () => {
      const id = (e_id.value||'').trim(); if (!id) return;
      e_updateBtn.disabled = true;
      try{
        const ref = db.collection('listings').doc(id);
        const payload = {
          title: (e_title.value||'').trim(),
          type: e_type.value || 'บ้าน',
          listingMode: e_listingMode.value || 'sale',
          status: e_status.value || 'available',
          price: num(e_price.value),
          priceUnit: (e_priceUnit.value||'').trim(),
          bedrooms: num(e_bedrooms.value),
          bathrooms: num(e_bathrooms.value),
          usableArea: num(e_usableArea.value),
          landSize: num(e_landSize.value),
          parking: num(e_parking.value),
          desc: (e_desc.value||'').trim(),
          fbUrl: safeUrl(e_fbUrl.value),
          lat: num(e_lat.value),
          lng: num(e_lng.value),
          updatedAt: firebase.firestore.FieldValue.serverTimestamp()
        };
        await ref.update(payload);

        const newFiles = Array.from(e_imgs.files||[]);
        if (newFiles.length){
          toast('กำลังอัปโหลดรูปเพิ่ม…');
          const items = await uploadToDrive(newFiles);
          const snap = await ref.get();
          const before = snap.data() || {};
          const merged = (Array.isArray(before.imageObjs) ? before.imageObjs : []).concat(items);
          await ref.update({ imageObjs: merged, updatedAt: firebase.firestore.FieldValue.serverTimestamp() });
        }

        toast('อัปเดตแล้ว','success');
        editModal.hidden = true;
      }catch(err){
        console.error(err);
        if (String(err).includes('permission')) return rulesHint('อัปเดต');
        toast('อัปเดตล้มเหลว: '+(err.message||''),'error',4000);
      }finally{
        e_updateBtn.disabled = false;
      }
    });

    e_deleteBtn?.addEventListener('click', async () => {
      const id = (e_id.value||'').trim(); if (!id) return;
      if (!confirmDialog('ยืนยันลบประกาศนี้?')) return;
      try{
        // Also try to remove associated drive files
        const snap = await db.collection('listings').doc(id).get();
        const it = snap.exists ? snap.data() : null;
        const ids = (it && Array.isArray(it.imageObjs)) ? it.imageObjs.map(o => o.id).filter(Boolean) : [];
        if (ids.length){ try{ await deleteDriveFiles(ids); }catch(e){ console.warn('drive delete:', e); } }
        await db.collection('listings').doc(id).delete();
        toast('ลบประกาศแล้ว','success');
        editModal.hidden = true;
      }catch(err){
        console.error(err);
        if (String(err).includes('permission')) return rulesHint('ลบประกาศ');
        toast('ลบล้มเหลว','error');
      }
    });

    /* Listings table (real-time) */
    function renderTable(items){
      // map markers
      allMarkers.clearLayers();
      const bounds = [];
      items.forEach(it => {
        if (it.lat && it.lng){
          const urls = getImageURLs(it);
          const mk = L.marker([it.lat,it.lng], { icon: iconThumbAdmin(urls[0]||'', it.status==='sold') });
          mk.on('click', () => openEdit(it));
          allMarkers.addLayer(mk);
          bounds.push([it.lat,it.lng]);
        }
      });
      if (bounds.length){ try{ allMap.fitBounds(bounds, { padding:[20,20], maxZoom:15 }); }catch{} }

      const wrap = byId('tableWrap');
      if (!wrap) return;
      wrap.innerHTML = '';
      const tbl = create('table');
      const thead = create('thead');
      thead.innerHTML = '<tr><th>หัวข้อ</th><th>ประเภท</th><th>โหมด</th><th>สถานะ</th><th>ราคา</th><th>พิกัด</th><th></th></tr>';
      tbl.appendChild(thead);
      const tbody = create('tbody');
      items.forEach(it => {
        const tr = create('tr');
        tr.appendChild(create('td', { text: it.title || '-' }));
        tr.appendChild(create('td', { text: it.type || '-' }));
        const tdMode = create('td'); tdMode.appendChild(create('span', { class:'badge mode-'+(it.listingMode==='rent'?'rent':'sale'), text: MODE_LABEL[it.listingMode]||'ขาย' })); tr.appendChild(tdMode);
        const tdStatus = create('td'); tdStatus.appendChild(create('span', { class:'badge '+(it.status||'available'), text: STATUS_LABEL[it.status]||STATUS_LABEL.available })); tr.appendChild(tdStatus);
        tr.appendChild(create('td', { text: baht(it.price) + (it.priceUnit?' ('+it.priceUnit+')':'') }));
        tr.appendChild(create('td', { text: (it.lat&&it.lng)? Number(it.lat).toFixed(4)+','+Number(it.lng).toFixed(4) : '-' }));
        const tdAct = create('td', { class:'btn-row' });
        tdAct.appendChild(create('button', { class:'btn btn-ghost', text:'แก้ไข', onclick: () => openEdit(it) }));
        tr.appendChild(tdAct);
        tbody.appendChild(tr);
      });
      tbl.appendChild(tbody);
      wrap.appendChild(tbl);
    }

    db.collection('listings').orderBy('createdAt','desc').onSnapshot(snap => {
      const items = snap.docs.map(d => ({ id:d.id, ...d.data() }));
      renderTable(items);
    }, err => {
      console.error(err);
      if (String(err).includes('permission')) rulesHint('โหลดรายการ');
    });

    /* Lightbox (admin can also use) */
    setupLightbox();
  }

})();
