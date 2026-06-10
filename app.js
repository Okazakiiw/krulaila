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
      const d34 = s.match(/!3d(-?\d+(\.\d+)?)!4d(-?\d+(\.\d+)?)/);   // data=...!3dLAT!4dLNG
      if(d34) return {lat:+d34[1], lng:+d34[3]};
      const q = s.match(/[?&]q=([-0-9.,\s]+)/);
      if(q){ const p = q[1].split(',').map(x=>+x.trim()); if(p.length>=2 && !isNaN(p[0]) && !isNaN(p[1])) return {lat:p[0], lng:p[1]}; }
      const simple = s.match(/(-?\d+(\.\d+)?),\s*(-?\d+(\.\d+)?)/);
      if(simple) return {lat:+simple[1], lng:+simple[3]};
    }catch{}
    return null;
  };
  // ลิงก์ย่อ Google Maps (maps.app.goo.gl ฯลฯ) ไม่มีพิกัดในตัว — ต้องให้ server ตาม redirect ก่อน
  async function resolveGmapToCoords(url){
    const raw = (url||'').trim();
    if (!raw) return null;
    const direct = parseGmapLink(raw);            // URL เต็มที่มีพิกัดอยู่แล้ว
    if (direct) return direct;
    if (/^https?:\/\/(maps\.app\.goo\.gl|goo\.gl|g\.co|maps\.google\.)/i.test(raw)){
      try{
        const r = await gasCall({ action:'resolveGmap', url: raw });
        if (r && r.ok){
          if (r.lat!=null && r.lng!=null) return { lat:r.lat, lng:r.lng };
          if (r.url) return parseGmapLink(r.url);
        }
      }catch(e){ console.warn('resolveGmap:', e); }
    }
    return null;
  }

  /* =========================================================================
     2b) แผนที่: base layers ฟรี (ไม่ต้องมี API key) + ตัวสลับ Layer
         - ถนน      : OpenStreetMap
         - ดาวเทียม  : Esri World Imagery
         - ดาวเทียม + ป้ายชื่อ : Esri Imagery + ถนน + ชื่อสถานที่ (ซ้อนกัน)
     หมายเหตุ: tile ของ Esri ใช้ลำดับ {z}/{y}/{x} (y ก่อน x)
     ต้องสร้าง instance ใหม่ทุกครั้งที่เรียก เพราะ tileLayer 1 ตัวใช้กับ map ได้ทีละแผนที่
  ========================================================================= */
  function buildMapLayers(){
    const osm = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom:19, attribution:'© OpenStreetMap'
    });
    const esriImg = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
      maxZoom:19, attribution:'Tiles © Esri'
    });
    // hybrid: ภาพดาวเทียม + ถนน + ป้ายชื่อ (instance แยกจาก esriImg ด้านบน)
    const hybridImg = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
      maxZoom:19, attribution:'Tiles © Esri'
    });
    const roads = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Transportation/MapServer/tile/{z}/{y}/{x}', { maxZoom:19 });
    const places = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}', { maxZoom:19 });
    const hybrid = L.layerGroup([hybridImg, roads, places]);
    return {
      base: { 'ถนน': osm, 'ดาวเทียม': esriImg, 'ดาวเทียม + ป้ายชื่อ': hybrid },
      default: osm
    };
  }

  /* สุ่มเลื่อนพิกัดออกจากจุดจริงภายในรัศมี radiusM เมตร (กระจายสม่ำเสมอทั่ววง)
     ใช้ซ่อนตำแหน่งจริงของทรัพย์ — จุดจริงจะอยู่ในวงรัศมีเดียวกันเสมอแต่ไม่ใช่จุดกึ่งกลาง */
  function jitterLatLng(lat, lng, radiusM){
    const R = Math.max(0, +radiusM || 0);
    if (!R || isNaN(+lat) || isNaN(+lng)) return { lat:+lat, lng:+lng };
    const ang  = Math.random() * 2 * Math.PI;
    const dist = R * Math.sqrt(Math.random());          // sqrt = กระจายทั่วพื้นที่วง (ไม่กระจุกกลาง)
    const dLat = (dist * Math.cos(ang)) / 111320;
    const dLng = (dist * Math.sin(ang)) / (111320 * Math.cos(+lat * Math.PI / 180));
    return { lat:+(+lat + dLat).toFixed(6), lng:+(+lng + dLng).toFixed(6) };
  }

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
     6.5) Apps Script generic caller + FB import helpers
  ========================================================================= */
  async function gasCall(payload){
    if (!GAS_UPLOAD_URL) throw new Error('GAS_UPLOAD_URL is not set');
    const idToken = await getAuthToken();
    const res = await fetch(GAS_UPLOAD_URL, {
      method:'POST',
      headers:{ 'Content-Type':'text/plain;charset=utf-8' },
      body: JSON.stringify({ ...payload, token: GAS_SHARED_TOKEN, idToken })
    });
    return res.json();
  }
  async function importViaUrls(urls){
    const r = await gasCall({ action:'importUrls', urls });
    if (!r.ok) throw new Error(r.error || 'Import failed');
    return r;  // { ok, items, errors }
  }
  async function importViaPostUrl(postUrl){
    const r = await gasCall({ action:'importFbShare', postUrl });
    if (!r.ok) throw new Error(r.error || 'Import failed');
    // diagnostic: ดูว่า server พบกี่รูป (found) และดึง HTML จากแหล่งใดได้บ้าง (sources)
    console.log('[importFbShare] found:', r.found, 'imported:', (r.items||[]).length, 'sources:', r.sources, 'errors:', r.errors);
    return r;  // { ok, items, errors, message, found, sources }
  }
  async function listRecentFbPosts(){
    const r = await gasCall({ action:'listFbPosts' });
    if (!r.ok) throw new Error(r.error || 'List failed');
    return r.posts || [];
  }
  async function setFbCreds(payload){
    const r = await gasCall({ action:'setFbCreds', ...payload });
    if (!r.ok) throw new Error(r.error || 'setFbCreds failed');
    return r;
  }
  async function fbCredsStatus(){
    const r = await gasCall({ action:'fbCredsStatus' });
    if (!r.ok) throw new Error(r.error || 'status failed');
    return r;  // { pageId, hasToken }
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
  const STATUS_LABEL = { available:'เปิดขาย', reserved:'จองแล้ว', sold:'ขายแล้ว', draft:'ฉบับร่าง' };
  const MODE_LABEL   = { sale:'ขาย', rent:'เช่า' };

  /* ── รายการโปรด (localStorage) ── */
  const FAV_KEY = 'krulaila:favs';
  function getFavs(){ try { return JSON.parse(localStorage.getItem(FAV_KEY) || '[]'); } catch { return []; } }
  function isFav(id){ return getFavs().includes(id); }
  function toggleFav(id){
    const favs = getFavs(); const i = favs.indexOf(id);
    if (i >= 0) favs.splice(i,1); else favs.push(id);
    try { localStorage.setItem(FAV_KEY, JSON.stringify(favs)); } catch {}
    return i < 0;   // true = เพิ่งกดถูกใจ
  }

  /* ── ยอดดู: เพิ่มทีละ 1 (นับครั้งเดียวต่อเครื่อง) ── */
  function bumpView(it){
    if (!it || !it.id || !db) return false;
    try {
      const KEY = 'krulaila:viewed';
      const seen = JSON.parse(localStorage.getItem(KEY) || '[]');
      if (seen.includes(it.id)) return false;           // เครื่องนี้นับไปแล้ว
      seen.push(it.id); localStorage.setItem(KEY, JSON.stringify(seen));
      db.collection('listings').doc(it.id)
        .update({ views: firebase.firestore.FieldValue.increment(1) }).catch(()=>{});
      return true;
    } catch { return false; }
  }

  /* ── ป้าย ใหม่/ฮิต ── */
  const NEW_DAYS = 7;     // โพสต์ภายในกี่วันถือว่า "ใหม่"
  const HOT_VIEWS = 50;   // ยอดดูเท่าไรถือว่า "ฮิต"
  function createdMs_(it){
    const ts = it && it.createdAt;
    if (ts && typeof ts.toDate === 'function') return ts.toDate().getTime();
    if (ts && typeof ts.seconds === 'number') return ts.seconds * 1000;
    if (typeof ts === 'number') return ts;
    return null;
  }
  function isNewListing(it){ const ms = createdMs_(it); return ms != null && (Date.now() - ms) <= NEW_DAYS*86400000; }
  function isHotListing(it){ return (+it.views || 0) >= HOT_VIEWS; }
  function fmtPostDate(it){
    const ms = createdMs_(it);
    if (ms == null) return '';
    try {
      return new Date(ms).toLocaleString('th-TH', { day:'numeric', month:'short', year:'numeric', hour:'2-digit', minute:'2-digit' });
    } catch { return ''; }
  }

  /* ── ปักหมุด: คำนวณว่าหมดเวลาแล้วหรือยัง ──
     - it.pinned = true และไม่มี pinnedUntil → ปักตลอด
     - มี pinnedUntil → ปักจนกว่าจะถึงเวลานั้น */
  function pinnedUntilMs_(it){
    const t = it && it.pinnedUntil;
    if (!t) return null;
    if (typeof t.toDate === 'function') return t.toDate().getTime();
    if (typeof t.seconds === 'number') return t.seconds * 1000;
    if (typeof t === 'number') return t;
    return null;
  }
  function effectivePinned(it){
    if (!it || !it.pinned) return false;
    const until = pinnedUntilMs_(it);
    return (until == null) || Date.now() < until;
  }
  /* สร้าง field สำหรับ save: ใส่ pinnedUntil ใหม่เฉพาะตอนปักครั้งแรก (fresh pin)
     - was=true, now=true  → ไม่แตะ pinnedUntil เดิม (ไม่ reset เวลา)
     - was=false, now=true → fresh pin → ตั้ง pinnedUntil = now + default
     - now=false           → ล้าง pinnedUntil */
  function pinPayload_(checkedNow, wasPinned){
    if (!checkedNow) return wasPinned ? { pinned:false, pinnedUntil:null } : { pinned:false };
    if (wasPinned) return { pinned:true };   // ไม่แตะ pinnedUntil เดิม
    const days = +(siteSettings && siteSettings.pinDefaultDays);
    if (days > 0){
      return { pinned:true, pinnedUntil: firebase.firestore.Timestamp.fromMillis(Date.now() + days*86400000) };
    }
    return { pinned:true, pinnedUntil:null };
  }

  function badgeFor(it){
    const wrap = create('span', { class:'row', style:{ gap:'4px' } });
    if (effectivePinned(it)) wrap.appendChild(create('span', { class:'badge badge-pin', text:'📌 แนะนำ' }));
    const mode = it.listingMode === 'rent' ? 'rent' : 'sale';
    wrap.appendChild(create('span', { class:'badge mode-'+mode, text: MODE_LABEL[mode] }));
    const st = it.status || 'available';
    wrap.appendChild(create('span', { class:'badge '+st, text: STATUS_LABEL[st] || STATUS_LABEL.available }));
    if (isNewListing(it)) wrap.appendChild(create('span', { class:'badge badge-new', text:'ใหม่' }));
    if (isHotListing(it)) wrap.appendChild(create('span', { class:'badge badge-hot', text:'🔥 ฮิต' }));
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
    const mapLayers = buildMapLayers();
    const map = L.map('map', { scrollWheelZoom:true, layers:[mapLayers.default] }).setView([13.736717,100.523186], 6);
    L.control.layers(mapLayers.base, null, { collapsed:true }).addTo(map);
    const cluster = (typeof L.markerClusterGroup === 'function')
      ? L.markerClusterGroup({ showCoverageOnHover:false, maxClusterRadius:50 })
      : L.layerGroup();
    map.addLayer(cluster);
    const circlesLayer = L.layerGroup().addTo(map);   // วงรัศมีสำหรับประกาศที่ตำแหน่งไม่ชัด

    /* Refs */
    const listEl  = byId('listings');
    const skel    = byId('skelList');
    const detail  = byId('detailPanel');
    const fltType = byId('fltType'), fltMin = byId('fltMin'), fltMax = byId('fltMax');
    const fltMode = byId('fltMode'), fltStatus = byId('fltStatus'), fltSort = byId('fltSort');
    const fltSearch = byId('fltSearch');
    const addrQuery = byId('addrQuery'), addrBtn = byId('addrSearch'), addrRes = byId('addrResults');
    const loadMoreWrap = byId('loadMoreWrap'), loadMoreBtn = byId('loadMoreBtn');
    const favToggle = byId('favToggle'), favCountEl = byId('favCount');

    /* Site settings → footer + topbar FB link */
    await loadSiteSettings();
    applySiteToIndex();

    /* Types */
    const types = await loadTypes();
    renderTypeOptions([fltType], types, true);

    /* Data state */
    let allItems = [];
    let visibleCount = 12;
    let favOnly = false;          // กรองเฉพาะรายการโปรด
    const PAGE = 12;

    function updateFavCount(){ if (favCountEl) favCountEl.textContent = getFavs().length; }
    updateFavCount();

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

    /* ค้นหาเฉพาะประกาศที่มีในรายการ → เลื่อนแผนที่ไปตำแหน่งนั้น + เปิดรายละเอียด
       (เดิมใช้ Nominatim ค้นที่อยู่ทั่วโลก — เปลี่ยนเป็นค้นจาก allItems ที่มีพิกัดจริง) */
    function runAddrSearch(){
      const q = (addrQuery?.value||'').trim().toLowerCase();
      if (!addrRes) return;
      addrRes.innerHTML = '';
      if (!q){ return; }
      const matches = allItems.filter(it => {
        if ((it.status||'available') === 'draft') return false;   // ไม่ค้นเจอฉบับร่าง
        if (!(it.lat && it.lng)) return false;   // ต้องมีพิกัดถึงจะเลื่อนแผนที่ได้
        const hay = (it.title + ' ' + (it.desc||'') + ' ' + (it.type||'')).toLowerCase();
        return hay.includes(q);
      });
      if (!matches.length){ addrRes.textContent = 'ไม่พบประกาศที่ตรงกับคำค้น'; return; }
      matches.slice(0, 10).forEach(it => {
        const item = create('div', { class:'addr-item', role:'option',
          text: it.title + (it.type ? ' · ' + it.type : ''),
          onclick: () => {
            map.flyTo([+it.lat, +it.lng], 16, { duration:.6 });
            addrRes.innerHTML = '';
            navigateTo(`#/listing/${encodeURIComponent(it.id)}`);
          }
        });
        addrRes.appendChild(item);
      });
    }
    addrBtn?.addEventListener('click', runAddrSearch);
    addrQuery?.addEventListener('keydown', e => { if (e.key==='Enter') runAddrSearch(); });

    /* Filters */
    function passFilter(it){
      if ((it.status||'available') === 'draft') return false;   // ฉบับร่าง = ไม่โชว์บนเว็บ public
      if (favOnly && !isFav(it.id)) return false;
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
      const arr = items.slice();
      if (s === 'priceAsc')  arr.sort((a,b)=> (+a.price||0) - (+b.price||0));
      else if (s === 'priceDesc') arr.sort((a,b)=> (+b.price||0) - (+a.price||0));
      // 'new' = ลำดับ createdAt desc จาก query อยู่แล้ว
      // ปักหมุดที่ "ยังไม่หมดเวลา" ขึ้นบนสุด (sort เสถียร → คงลำดับเดิมในแต่ละกลุ่ม)
      arr.sort((a,b)=> (effectivePinned(b)?1:0) - (effectivePinned(a)?1:0));
      return arr;
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

      const card = create('div', { class:'card-item glass' + (isSold ? ' is-sold' : '') + (effectivePinned(it) ? ' pinned' : '') });

      const img = create('img', {
        alt: it.title || '',
        loading:'lazy',
        src: firstURL || 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="120" height="120"><rect fill="%23eaf2ff" width="120" height="120"/><text x="50%" y="55%" text-anchor="middle" font-size="32" fill="%23b6c8e6">🏠</text></svg>'
      });
      card.appendChild(img);

      // ปุ่มหัวใจ — บันทึกรายการโปรด (กันไม่ให้คลิกทะลุไปเปิดรายละเอียด)
      const favBtn = create('button', { class:'fav-btn' + (isFav(it.id) ? ' on' : ''), type:'button',
        'aria-label':'บันทึกรายการโปรด', text: isFav(it.id) ? '❤️' : '🤍' });
      favBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const on = toggleFav(it.id);
        favBtn.classList.toggle('on', on);
        favBtn.textContent = on ? '❤️' : '🤍';
        updateFavCount();
        if (favOnly && !on) renderIndex();   // กำลังกรองเฉพาะโปรด → เอาออกทันที
      });
      card.appendChild(favBtn);

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
      if (it.views)      specBits.push(`👁 ${it.views}`);
      if (specBits.length){
        content.appendChild(create('div', { class:'small', text: specBits.join('  ·  ') }));
      }
      const cardDate = fmtPostDate(it);
      if (cardDate) content.appendChild(create('div', { class:'small muted', text: '📅 ' + cardDate }));

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
      const justCounted = bumpView(it);   // นับยอดดู (ครั้งเดียวต่อเครื่อง)

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

      // view count + posted date
      const vc = (+it.views || 0) + (justCounted ? 1 : 0);
      if (vc) body.appendChild(create('div', { class:'small muted', text:`👁 เข้าชม ${vc} ครั้ง` }));
      const postDate = fmtPostDate(it);
      if (postDate) body.appendChild(create('div', { class:'small muted', text:'📅 โพสต์เมื่อ ' + postDate }));

      // spec grid
      const sg = specGridFor(it); if (sg) body.appendChild(sg);

      // description
      if (it.desc){
        const p = create('div', { style:{ whiteSpace:'pre-wrap', lineHeight:1.55 } });
        p.textContent = it.desc;
        body.appendChild(p);
      }

      // actions: map + mortgage
      if (it.lat && it.lng && it.approxLocation){
        body.appendChild(create('div', { class:'small muted', text:'📍 ตำแหน่งบนแผนที่เป็นพื้นที่โดยประมาณ (รัศมี) ไม่ใช่จุดที่ตั้งจริง' }));
      }

      const actions = create('div', { class:'detail-actions' });
      if (it.lat && it.lng){
        // approx → ใช้จุดแสดงผล (สุ่ม) ไม่เปิดพิกัดจริง
        const lLat = (it.approxLocation && it.dispLat != null) ? it.dispLat : it.lat;
        const lLng = (it.approxLocation && it.dispLng != null) ? it.dispLng : it.lng;
        actions.appendChild(create('a', { class:'btn btn-secondary',
          href: mapLink(lLat,lLng), target:'_blank', rel:'noopener',
          text: it.approxLocation ? '🗺️ ดูทำเลโดยประมาณ' : '🗺️ เปิด Google Maps' }));
      }
      if (it.price && !isRent){
        actions.appendChild(create('button', { class:'btn btn-secondary', text:'🧮 คำนวณค่างวด',
          onclick: () => openLoan(+it.price)
        }));
      }
      // favourite toggle
      const detFav = create('button', { class:'btn btn-ghost', type:'button',
        text: isFav(it.id) ? '❤️ บันทึกแล้ว' : '🤍 บันทึก' });
      detFav.addEventListener('click', () => {
        const on = toggleFav(it.id);
        detFav.textContent = on ? '❤️ บันทึกแล้ว' : '🤍 บันทึก';
        updateFavCount();
        if (favOnly && !on) renderIndex();
      });
      actions.appendChild(detFav);
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
      circlesLayer.clearLayers();
      listEl.innerHTML = '';

      const slice = filtered.slice(0, visibleCount);
      const bounds = [];
      slice.forEach(it => {
        const urls = getImageURLs(it);
        const firstURL = urls[0] || '';
        if (it.lat && it.lng){
          if (it.approxLocation){
            // ตำแหน่งไม่ชัด → วงรัศมีรอบ "จุดแสดงผลที่สุ่มไว้" (dispLat/dispLng) ไม่ใช่พิกัดจริง
            const cLat = (it.dispLat != null) ? it.dispLat : it.lat;
            const cLng = (it.dispLng != null) ? it.dispLng : it.lng;
            const circle = L.circle([cLat, cLng], {
              radius: +it.approxRadius || 300,
              color:'#2563eb', weight:1.5, fillColor:'#2563eb', fillOpacity:.15
            });
            if (firstURL){
              circle.bindTooltip(
                `<div class="tt-title">${escapeHTML(it.title||'')}</div><img src="${escapeHTML(firstURL)}" alt="" loading="lazy">`,
                { direction:'top', sticky:true, opacity:1, className:'thumb-tip' }
              );
            }
            circle.on('click', () => navigateTo(`#/listing/${encodeURIComponent(it.id)}`));
            circlesLayer.addLayer(circle);
            bounds.push([cLat, cLng]);
          } else {
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
      favOnly = false; favToggle?.classList.remove('active'); favToggle?.setAttribute('aria-pressed','false');
      visibleCount = PAGE;
      renderIndex();
    });
    favToggle?.addEventListener('click', () => {
      favOnly = !favOnly;
      favToggle.classList.toggle('active', favOnly);
      favToggle.setAttribute('aria-pressed', String(favOnly));
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
          f_listingMode=byId('f_listingMode'), f_status=byId('f_status'), f_pinned=byId('f_pinned'),
          f_price=byId('f_price'), f_priceUnit=byId('f_priceUnit'),
          f_bedrooms=byId('f_bedrooms'), f_bathrooms=byId('f_bathrooms'),
          f_usableArea=byId('f_usableArea'), f_landSize=byId('f_landSize'),
          f_parking=byId('f_parking'),
          f_desc=byId('f_desc'), f_fbUrl=byId('f_fbUrl'),
          f_gmap=byId('f_gmap'), f_lat=byId('f_lat'), f_lng=byId('f_lng'),
          f_approxLoc=byId('f_approxLoc'), f_approxRadius=byId('f_approxRadius'), f_approxBtn=byId('f_approxBtn'), f_approxOut=byId('f_approxOut'),
          f_imgs=byId('f_imgs'), imgsPrev=byId('imgsPrev');
    const saveBtn=byId('saveBtn'), exportBtn=byId('exportBtn'),
          importBtn=byId('importBtn'), importFile=byId('importFile');

    /* Refs — edit */
    const editModal=byId('editModal'), closeEdit=byId('closeEdit');
    const e_id=byId('e_id'), e_title=byId('e_title'), e_type=byId('e_type'),
          e_listingMode=byId('e_listingMode'), e_status=byId('e_status'), e_pinned=byId('e_pinned'),
          e_price=byId('e_price'), e_priceUnit=byId('e_priceUnit'),
          e_bedrooms=byId('e_bedrooms'), e_bathrooms=byId('e_bathrooms'),
          e_usableArea=byId('e_usableArea'), e_landSize=byId('e_landSize'),
          e_parking=byId('e_parking'),
          e_desc=byId('e_desc'), e_fbUrl=byId('e_fbUrl'),
          e_gmap=byId('e_gmap'), e_lat=byId('e_lat'), e_lng=byId('e_lng'),
          e_approxLoc=byId('e_approxLoc'), e_approxRadius=byId('e_approxRadius'), e_approxBtn=byId('e_approxBtn'), e_approxOut=byId('e_approxOut'),
          e_imgs=byId('e_imgs'), e_imgsPrev=byId('e_imgsPrev'),
          e_updateBtn=byId('e_updateBtn'), e_deleteBtn=byId('e_deleteBtn'),
          e_imgsList=byId('e_imgsList');

    /* Map (admin overview) */
    const allMapLayers = buildMapLayers();
    const allMap = L.map('allMap', { layers:[allMapLayers.default] }).setView([13.736717,100.523186], 6);
    L.control.layers(allMapLayers.base, null, { collapsed:true }).addTo(allMap);
    const allMarkers = (typeof L.markerClusterGroup === 'function')
      ? L.markerClusterGroup({ showCoverageOnHover:false })
      : L.layerGroup();
    allMap.addLayer(allMarkers);
    const iconThumbAdmin = (url, isSold) => L.divIcon({
      html: `<div class="thumb-marker${isSold?' is-sold':''}">${url?`<img src="${escapeHTML(url)}" alt="" loading="lazy">`:'<span class="pin-fallback">🏠</span>'}</div>`,
      className:'', iconSize:[52,52], iconAnchor:[26,26]
    });

    /* Parse gmap links */
    f_gmap?.addEventListener('change', async () => {
      const v=(f_gmap.value||'').trim(); if(!v) return;
      const g=await resolveGmapToCoords(v);
      if(g){ f_lat.value=g.lat; f_lng.value=g.lng; clearDisp_(f_approxLoc,f_approxOut); toast('ดึงพิกัดสำเร็จ','success'); }
      else toast('ดึงพิกัดไม่สำเร็จ — ลองวางพิกัดเอง','warn');
    });
    e_gmap?.addEventListener('change', async () => {
      const v=(e_gmap.value||'').trim(); if(!v) return;
      const g=await resolveGmapToCoords(v);
      if(g){ e_lat.value=g.lat; e_lng.value=g.lng; clearDisp_(e_approxLoc,e_approxOut); toast('ดึงพิกัดสำเร็จ','success'); }
      else toast('ดึงพิกัดไม่สำเร็จ — ลองวางพิกัดเอง','warn');
    });

    /* ── ตำแหน่งแบบไม่ชัด: ปุ่มสุ่ม "จุดแสดงผล" แยกต่างหาก — ไม่แตะ lat/lng เดิม ──
       จุดสุ่มเก็บใน dataset ของ checkbox (dispLat/dispLng) แล้วบันทึกเป็น field แยกตอนเซฟ
       พิกัดจริงในช่อง lat/lng คงไว้เหมือนเดิมเสมอ */
    function clearDisp_(chkEl, outEl){
      if (chkEl){ delete chkEl.dataset.dispLat; delete chkEl.dataset.dispLng; }
      if (outEl) outEl.textContent = '';
    }
    function applyJitter_(latEl, lngEl, radiusEl, chkEl, outEl){
      const lat = +latEl.value, lng = +lngEl.value;
      if (isNaN(lat) || isNaN(lng) || (!lat && !lng)){
        toast('ใส่พิกัดจริง (ละติจูด/ลองจิจูด) ก่อน แล้วค่อยกดสุ่ม','warn'); return;
      }
      const r = +radiusEl.value || 300;
      const j = jitterLatLng(lat, lng, r);          // สุ่มจากพิกัดจริง แต่ไม่เขียนทับช่อง
      if (chkEl){ chkEl.checked = true; chkEl.dataset.dispLat = j.lat; chkEl.dataset.dispLng = j.lng; }
      if (outEl) outEl.textContent = `จุดแสดงผล (สุ่มในรัศมี ${r} ม.): ${j.lat}, ${j.lng}`;
      toast(`สุ่มจุดแสดงผลแล้ว (รัศมี ${r} ม.) — พิกัดจริงไม่ถูกแก้`, 'success', 4000);
    }
    f_approxBtn?.addEventListener('click', () => applyJitter_(f_lat, f_lng, f_approxRadius, f_approxLoc, f_approxOut));
    e_approxBtn?.addEventListener('click', () => applyJitter_(e_lat, e_lng, e_approxRadius, e_approxLoc, e_approxOut));
    // เปลี่ยนพิกัดจริง หรือ ปิด approx → จุดสุ่มเดิมใช้ไม่ได้แล้ว ล้างทิ้ง
    f_lat?.addEventListener('input', () => clearDisp_(f_approxLoc,f_approxOut));
    f_lng?.addEventListener('input', () => clearDisp_(f_approxLoc,f_approxOut));
    e_lat?.addEventListener('input', () => clearDisp_(e_approxLoc,e_approxOut));
    e_lng?.addEventListener('input', () => clearDisp_(e_approxLoc,e_approxOut));
    f_approxLoc?.addEventListener('change', () => { if(!f_approxLoc.checked) clearDisp_(f_approxLoc,f_approxOut); });
    e_approxLoc?.addEventListener('change', () => { if(!e_approxLoc.checked) clearDisp_(e_approxLoc,e_approxOut); });

    /* สร้าง field ตอนบันทึก: เก็บพิกัดจริงไว้ตามเดิม (ทำแยกในpayload) + จุดสุ่ม dispLat/dispLng
       ถ้าติ๊ก approx แต่ลืมกดสุ่ม → สุ่มให้อัตโนมัติจากพิกัดจริง กันไม่ให้จุดแสดง = จุดจริง */
    function approxFields_(latEl, lngEl, radiusEl, chkEl){
      const on = !!chkEl?.checked;
      const out = { approxLocation: on, approxRadius: on ? (+radiusEl?.value || 300) : 0, dispLat: null, dispLng: null };
      if (!on) return out;
      let dLat = +chkEl.dataset.dispLat, dLng = +chkEl.dataset.dispLng;
      if (isNaN(dLat) || isNaN(dLng)){
        const tLat = num(latEl?.value), tLng = num(lngEl?.value);
        if (tLat !== '' && tLng !== ''){ const j = jitterLatLng(tLat, tLng, out.approxRadius); dLat = j.lat; dLng = j.lng; }
      }
      if (!isNaN(dLat) && !isNaN(dLng)){ out.dispLat = dLat; out.dispLng = dLng; }
      return out;
    }

    /* Site settings UI */
    await loadSiteSettings();
    byId('s_phone').value = siteSettings.phone || '';
    byId('s_lineId').value = siteSettings.lineId || '';
    byId('s_lineUrl').value = siteSettings.lineUrl || '';
    byId('s_facebookPage').value = siteSettings.facebookPage || '';
    byId('s_messengerUrl').value = siteSettings.messengerUrl || '';
    byId('s_about').value = siteSettings.aboutText || '';
    byId('s_pinDefaultDays').value = (siteSettings.pinDefaultDays != null) ? siteSettings.pinDefaultDays : 14;
    byId('saveSiteBtn')?.addEventListener('click', async () => {
      try{
        const payload = {
          phone: (byId('s_phone').value||'').trim(),
          lineId: (byId('s_lineId').value||'').trim(),
          lineUrl: (byId('s_lineUrl').value||'').trim(),
          facebookPage: (byId('s_facebookPage').value||'').trim(),
          messengerUrl: (byId('s_messengerUrl').value||'').trim(),
          aboutText: (byId('s_about').value||'').trim(),
          pinDefaultDays: Math.max(0, parseInt(byId('s_pinDefaultDays').value||'14', 10) || 0),
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

    /* ─────── Facebook integration ─────── */
    /* ใช้วิธี parse og:image จากหน้า public posts โดยตรง ไม่ต้องใช้ Page Access Token
       (ส่วนของ Page Access Token เดิมถูกถอดออกจาก UI แล้ว แต่ Apps Script ยังรองรับ
       action 'importFbPost' / 'setFbCreds' เผื่อมีคนต้องการใช้ในอนาคต) */

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

    /* ─────── Import images via URL / FB post (create form) ─────── */
    let _addImported = [];   // [{ id, url, name }] รออัปเดตเข้า imageObjs ตอน save
    const f_importedPrev = byId('f_importedPrev');
    function renderAddImported(){
      f_importedPrev.innerHTML = '';
      _addImported.forEach((o, idx) => {
        const cell = create('div');
        cell.appendChild(create('img', { src: o.url, alt:'', loading:'lazy' }));
        cell.appendChild(create('span', { class:'imported-tag', text:'📘 FB' }));
        const del = create('button', { class:'btn btn-ghost btn-danger', text:'ลบ' });
        del.addEventListener('click', async () => {
          try{ if (o.id) await deleteDriveFiles([o.id]); }catch(e){ console.warn(e); }
          _addImported.splice(idx, 1);
          renderAddImported();
        });
        cell.appendChild(del);
        f_importedPrev.appendChild(cell);
      });
    }

    byId('f_importUrlsBtn')?.addEventListener('click', async () => {
      const text = (byId('f_importUrls').value||'').trim();
      if (!text) return toast('วาง URL ก่อน','warn');
      const urls = text.split(/\s+/).filter(u => /^https?:\/\//i.test(u));
      if (!urls.length) return toast('ไม่พบ URL ที่ถูกต้อง','warn');
      const btn = byId('f_importUrlsBtn'); btn.disabled = true;
      try{
        toast('กำลังดึงรูปและเซฟลง Drive…');
        const r = await importViaUrls(urls);
        _addImported.push(...(r.items||[]));
        renderAddImported();
        byId('f_importUrls').value = '';
        const okN = (r.items||[]).length;
        const errN = (r.errors||[]).length;
        if (errN){
          console.warn('Import errors:', r.errors);
          // เอา error แรกมาแสดงใน toast เพื่อให้รู้สาเหตุ
          const firstErr = r.errors[0].error || 'unknown';
          toast(`สำเร็จ ${okN} · ล้มเหลว ${errN} — ${firstErr}`,'warn',6000);
        } else {
          toast(`นำเข้า ${okN} รูปแล้ว`,'success');
        }
      }catch(err){
        toast('นำเข้าล้มเหลว: '+err.message,'error',5000);
      }finally{ btn.disabled = false; }
    });

    byId('f_importPostBtn')?.addEventListener('click', async () => {
      const postUrl = (byId('f_importPostUrl').value||'').trim();
      if (!postUrl) return toast('วาง URL โพสต์ก่อน','warn');
      const btn = byId('f_importPostBtn'); btn.disabled = true;
      try{
        toast('กำลังดึงรูปจากโพสต์…');
        const r = await importViaPostUrl(postUrl);
        _addImported.push(...(r.items||[]));
        renderAddImported();
        // เติม caption + ลิงก์โพสต์ FB ถ้าช่องยังว่าง
        if (r.message && !((f_desc?.value||'').trim())) f_desc.value = r.message;
        if (postUrl && !((f_fbUrl?.value||'').trim())) f_fbUrl.value = postUrl;
        byId('f_importPostUrl').value = '';
        toast(`นำเข้า ${r.items.length} รูปจากโพสต์`,'success');
      }catch(err){
        toast('ดึงโพสต์ล้มเหลว: '+err.message,'error',5000);
      }finally{ btn.disabled = false; }
    });

    byId('f_pickPostBtn')?.addEventListener('click', () => openFbPicker('add'));

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
          ...pinPayload_(!!f_pinned?.checked, false),   // ฟอร์มเพิ่ม: ยังไม่เคยปัก = fresh pin
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
          ...approxFields_(f_lat, f_lng, f_approxRadius, f_approxLoc),
          imageObjs: _addImported.slice(),   // imported ใส่ทันที
          createdAt: firebase.firestore.FieldValue.serverTimestamp(),
          updatedAt: firebase.firestore.FieldValue.serverTimestamp()
        };
        const docRef = await db.collection('listings').add(meta);

        if (add_files.length){
          toast('กำลังอัปโหลดรูปจากเครื่อง…');
          const items = await uploadToDrive(add_files);
          // merge ของจาก disk เข้ากับที่ import ไว้แล้ว
          const merged = (_addImported || []).concat(items);
          await docRef.update({ imageObjs: merged, updatedAt: firebase.firestore.FieldValue.serverTimestamp() });
        }

        byId('listingForm')?.reset();
        imgsPrev.innerHTML = '';
        f_importedPrev.innerHTML = '';
        add_files = [];
        _addImported = [];
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
      if (e_pinned){
        e_pinned.checked = !!it.pinned;
        e_pinned.dataset.initial = it.pinned ? '1' : '0';   // ไว้เช็คตอนเซฟ ว่าควรตั้ง pinnedUntil ใหม่ไหม
      }
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
      // ตำแหน่งไม่ชัด: ช่อง lat/lng = พิกัดจริง (โหลดด้านบนแล้ว) — จุดสุ่มเก็บแยกใน dataset
      if (e_approxLoc){
        e_approxLoc.checked = !!it.approxLocation;
        if (it.dispLat != null && it.dispLng != null){
          e_approxLoc.dataset.dispLat = it.dispLat; e_approxLoc.dataset.dispLng = it.dispLng;
        } else { delete e_approxLoc.dataset.dispLat; delete e_approxLoc.dataset.dispLng; }
      }
      if (e_approxRadius && it.approxRadius) e_approxRadius.value = String(it.approxRadius);
      if (e_approxOut) e_approxOut.textContent = (it.approxLocation && it.dispLat != null) ? `จุดแสดงผล: ${it.dispLat}, ${it.dispLng}` : '';

      // existing images — จัดเรียง / ตั้งเป็นปก / ลบ
      renderEditImages(it, currentImgArr_(it));

      e_imgs.value = '';
      e_imgsPrev.innerHTML = '';
      editModal.hidden = false;
    }

    /* ─────── จัดการรูปในหน้าแก้ไข: เรียงลำดับ / ตั้งปก / ลบ ─────── */
    function currentImgArr_(data){
      if (Array.isArray(data.imageObjs)) return data.imageObjs.slice();
      if (Array.isArray(data.imageURLs)) return data.imageURLs.map(u => ({ id:null, url: normalizeDriveImageURL(u) }));
      return [];
    }
    async function freshImgs_(it){
      const snap = await db.collection('listings').doc(it.id).get();
      return snap.exists ? currentImgArr_(snap.data()) : [];
    }
    function matchIdx_(arr, o){
      const u = normalizeDriveImageURL(o.url);
      return arr.findIndex(x => (o.id ? (x.id||'') === o.id : true) && normalizeDriveImageURL(x.url) === u);
    }
    async function persistImgs_(it, arr, deleteIds){
      try {
        if (deleteIds && deleteIds.length) await deleteDriveFiles(deleteIds);
        await db.collection('listings').doc(it.id).update({
          imageObjs: arr, updatedAt: firebase.firestore.FieldValue.serverTimestamp()
        });
        renderEditImages(it, arr);   // วาดใหม่จาก array ล่าสุด
      } catch(e){
        console.error(e);
        if (String(e).includes('permission')) return rulesHint('จัดการรูป');
        toast('จัดการรูปไม่สำเร็จ: ' + (e.message||''),'error',4000);
      }
    }
    async function moveImg_(it, o, dir){
      const arr = await freshImgs_(it);
      const i = matchIdx_(arr, o); if (i < 0) return;
      if (dir === 'cover'){ const [x] = arr.splice(i,1); arr.unshift(x); }
      else if (dir === 'left' && i > 0){ const t = arr[i-1]; arr[i-1] = arr[i]; arr[i] = t; }
      else if (dir === 'right' && i < arr.length-1){ const t = arr[i+1]; arr[i+1] = arr[i]; arr[i] = t; }
      else return;
      await persistImgs_(it, arr);
      toast(dir === 'cover' ? 'ตั้งเป็นรูปปกแล้ว' : 'สลับลำดับรูปแล้ว','success');
    }
    async function delImg_(it, o){
      if (!confirmDialog('ลบรูปนี้ออก' + (o.id ? ' (รวมจาก Google Drive)' : '') + ' ?')) return;
      const arr = await freshImgs_(it);
      const i = matchIdx_(arr, o); if (i < 0) return;
      const [removed] = arr.splice(i,1);
      await persistImgs_(it, arr, (removed && removed.id) ? [removed.id] : []);
      toast('ลบรูปแล้ว','success');
    }
    function renderEditImages(it, objs){
      if (!e_imgsList) return;
      e_imgsList.innerHTML = '';
      if (!objs.length){
        e_imgsList.appendChild(create('div', { class:'small muted', text:'— ไม่มีรูป —' }));
        return;
      }
      objs.forEach((o, idx) => {
        const u = normalizeDriveImageURL(o.url);
        const cell = create('div', { class:'edit-img-cell' });
        if (idx === 0) cell.appendChild(create('span', { class:'cover-badge', text:'⭐ ปก' }));
        cell.appendChild(create('img', { src:u, alt:'', loading:'lazy' }));
        const ctrls = create('div', { class:'btn-row img-ctrls' });
        if (idx > 0) ctrls.appendChild(create('button', { class:'btn btn-ghost', title:'ตั้งเป็นปก', text:'⭐', onclick: () => moveImg_(it, o, 'cover') }));
        if (idx > 0) ctrls.appendChild(create('button', { class:'btn btn-ghost', title:'เลื่อนซ้าย', text:'◀', onclick: () => moveImg_(it, o, 'left') }));
        if (idx < objs.length-1) ctrls.appendChild(create('button', { class:'btn btn-ghost', title:'เลื่อนขวา', text:'▶', onclick: () => moveImg_(it, o, 'right') }));
        ctrls.appendChild(create('button', { class:'btn btn-ghost btn-danger', text:'ลบ', onclick: () => delImg_(it, o) }));
        cell.appendChild(ctrls);
        e_imgsList.appendChild(cell);
      });
    }

    closeEdit?.addEventListener('click', () => editModal.hidden = true);
    editModal?.addEventListener('click', e => { if (e.target === editModal) editModal.hidden = true; });

    e_imgs?.addEventListener('change', () => {
      e_imgsPrev.innerHTML = '';
      Array.from(e_imgs.files||[]).slice(0,12).forEach(file => {
        const im = new Image(); im.src = URL.createObjectURL(file); e_imgsPrev.appendChild(im);
      });
    });

    /* ─────── Import images in EDIT form: ผูก Firestore ทันที ─────── */
    async function pushImportedToEdit(items, opts){
      opts = opts || {};
      const id = (e_id.value||'').trim();
      if (!id || !items || !items.length) return;
      const ref = db.collection('listings').doc(id);
      const snap = await ref.get();
      if (!snap.exists) throw new Error('ไม่พบประกาศนี้');
      const before = snap.data() || {};
      const merged = (Array.isArray(before.imageObjs) ? before.imageObjs : []).concat(items);
      const patch = { imageObjs: merged, updatedAt: firebase.firestore.FieldValue.serverTimestamp() };
      if (opts.caption && !((e_desc?.value||'').trim())){
        patch.desc = opts.caption;
        e_desc.value = opts.caption;
      }
      if (opts.fbUrl && !((e_fbUrl?.value||'').trim())){
        patch.fbUrl = safeUrl(opts.fbUrl);
        e_fbUrl.value = opts.fbUrl;
      }
      await ref.update(patch);
      renderEditImages({ id }, await freshImgs_({ id }));   // วาดรายการรูปใหม่ทั้งหมด (มีปุ่มจัดเรียง/ตั้งปก/ลบ)
    }

    byId('e_importUrlsBtn')?.addEventListener('click', async () => {
      const text = (byId('e_importUrls').value||'').trim();
      if (!text) return toast('วาง URL ก่อน','warn');
      const urls = text.split(/\s+/).filter(u => /^https?:\/\//i.test(u));
      if (!urls.length) return toast('ไม่พบ URL ที่ถูกต้อง','warn');
      const btn = byId('e_importUrlsBtn'); btn.disabled = true;
      try{
        toast('กำลังดึงรูปและเซฟลง Drive…');
        const r = await importViaUrls(urls);
        await pushImportedToEdit(r.items||[]);
        byId('e_importUrls').value = '';
        const okN = (r.items||[]).length;
        const errN = (r.errors||[]).length;
        if (errN){
          console.warn('Import errors:', r.errors);
          const firstErr = r.errors[0].error || 'unknown';
          toast(`สำเร็จ ${okN} · ล้มเหลว ${errN} — ${firstErr}`,'warn',6000);
        } else {
          toast(`นำเข้า ${okN} รูปแล้ว`,'success');
        }
      }catch(err){ toast('นำเข้าล้มเหลว: '+err.message,'error',5000); }
      finally{ btn.disabled = false; }
    });

    byId('e_importPostBtn')?.addEventListener('click', async () => {
      const postUrl = (byId('e_importPostUrl').value||'').trim();
      if (!postUrl) return toast('วาง URL โพสต์ก่อน','warn');
      const btn = byId('e_importPostBtn'); btn.disabled = true;
      try{
        toast('กำลังดึงรูปจากโพสต์…');
        const r = await importViaPostUrl(postUrl);
        await pushImportedToEdit(r.items||[], { caption: r.message || '', fbUrl: postUrl });
        byId('e_importPostUrl').value = '';
        toast(`นำเข้า ${r.items.length} รูปจากโพสต์`,'success');
      }catch(err){ toast('ดึงโพสต์ล้มเหลว: '+err.message,'error',5000); }
      finally{ btn.disabled = false; }
    });

    byId('e_pickPostBtn')?.addEventListener('click', () => {
      toast('ฟีเจอร์ "เลือกจากโพสต์ล่าสุด" ถูกถอดออก — ใช้ปุ่ม "ดึงจากโพสต์ FB" แล้วกรอก URL โพสต์โดยตรงแทน','info',5000);
    });
    byId('f_pickPostBtn')?.addEventListener('click', () => {
      toast('ฟีเจอร์ "เลือกจากโพสต์ล่าสุด" ถูกถอดออก — ใช้ปุ่ม "ดึงจากโพสต์ FB" แล้วกรอก URL โพสต์โดยตรงแทน','info',5000);
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
          ...pinPayload_(!!e_pinned?.checked, e_pinned?.dataset.initial === '1'),
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
          ...approxFields_(e_lat, e_lng, e_approxRadius, e_approxLoc),
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

    /* Listings table + stats (real-time) */
    let adminItems = [];

    // การ์ดสรุป + Top 5 ยอดดู
    function renderStats(items){
      const el = byId('adminStats'); if (!el) return;
      const by = (s) => items.filter(i => (i.status||'available') === s).length;
      const totalViews = items.reduce((a,i) => a + (+i.views||0), 0);
      el.innerHTML = '';
      const grid = create('div', { class:'stat-grid' });
      [ ['ประกาศทั้งหมด', items.length],
        ['เปิดขาย', by('available')],
        ['จองแล้ว', by('reserved')],
        ['ขายแล้ว', by('sold')],
        ['ฉบับร่าง', by('draft')],
        ['ยอดดูรวม', totalViews] ].forEach(([l,v]) => {
        const c = create('div', { class:'stat-card' });
        c.appendChild(create('div', { class:'stat-v', text: String(v) }));
        c.appendChild(create('div', { class:'stat-l', text: l }));
        grid.appendChild(c);
      });
      el.appendChild(grid);

      const top = items.filter(i => +i.views).sort((a,b) => (+b.views||0)-(+a.views||0)).slice(0,5);
      if (top.length){
        const box = create('div', { class:'top-views' });
        box.appendChild(create('div', { class:'small muted', style:{ marginBottom:'4px' }, text:'🔥 ยอดดูสูงสุด (คลิกเพื่อแก้ไข)' }));
        top.forEach((it,i) => {
          const row = create('div', { class:'top-row', onclick: () => openEdit(it) });
          row.appendChild(create('span', { class:'small', text: `${i+1}. ${it.title||'-'}` }));
          row.appendChild(create('span', { class:'small muted', text: `👁 ${+it.views||0}` }));
          box.appendChild(row);
        });
        el.appendChild(box);
      }
    }

    function adminFilterSort(){
      const q = (byId('adminSearch')?.value||'').trim().toLowerCase();
      const sort = byId('adminSort')?.value || 'new';
      let items = adminItems.filter(it => !q ||
        (`${it.title||''} ${it.type||''} ${it.desc||''}`).toLowerCase().includes(q));
      items = items.slice();
      if (sort === 'viewsDesc') items.sort((a,b)=>(+b.views||0)-(+a.views||0));
      else if (sort === 'priceDesc') items.sort((a,b)=>(+b.price||0)-(+a.price||0));
      else if (sort === 'priceAsc') items.sort((a,b)=>(+a.price||0)-(+b.price||0));
      // 'new' = ตามลำดับ createdAt desc จาก query อยู่แล้ว
      items.sort((a,b)=> (effectivePinned(b)?1:0) - (effectivePinned(a)?1:0));   // ปักหมุดที่ยังไม่หมดเวลา ขึ้นบนสุด
      return items;
    }

    function renderMarkers(items){
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
    }

    async function quickStatus(it, value){
      try {
        const patch = { status: value, updatedAt: firebase.firestore.FieldValue.serverTimestamp() };
        // ขายแล้ว → เลิกปักหมุดอัตโนมัติ (กันลืม)
        if (value === 'sold' && it.pinned){ patch.pinned = false; patch.pinnedUntil = null; }
        await db.collection('listings').doc(it.id).update(patch);
        toast('เปลี่ยนสถานะเป็น "' + (STATUS_LABEL[value]||value) + '"' + (patch.pinned===false?' (เลิกปักหมุดอัตโนมัติ)':''), 'success');
      } catch(e){
        console.error(e);
        if (String(e).includes('permission')) return rulesHint('เปลี่ยนสถานะ');
        toast('เปลี่ยนสถานะไม่สำเร็จ','error');
      }
    }

    async function duplicateListing(it){
      try {
        const { id:_i, createdAt:_c, updatedAt:_u, views:_v, ...fields } = it;
        fields.title = (it.title||'ประกาศ') + ' (สำเนา)';
        fields.status = 'draft';   // สำเนาเริ่มเป็นฉบับร่าง ไม่โชว์จนกว่าจะพร้อม
        fields.createdAt = firebase.firestore.FieldValue.serverTimestamp();
        fields.updatedAt = firebase.firestore.FieldValue.serverTimestamp();
        await db.collection('listings').add(fields);
        toast('ก๊อปปี้ประกาศแล้ว (เป็นฉบับร่าง) — แก้ไขแล้วเปลี่ยนสถานะเพื่อเผยแพร่','success',5000);
      } catch(e){
        console.error(e);
        if (String(e).includes('permission')) return rulesHint('ก๊อปปี้ประกาศ');
        toast('ก๊อปปี้ไม่สำเร็จ','error');
      }
    }

    async function togglePin(it){
      try {
        const payload = {
          ...pinPayload_(!it.pinned, !!it.pinned),
          updatedAt: firebase.firestore.FieldValue.serverTimestamp()
        };
        await db.collection('listings').doc(it.id).update(payload);
        if (it.pinned) toast('เลิกปักหมุดแล้ว','success');
        else {
          const days = +(siteSettings.pinDefaultDays);
          toast('ปักหมุดแล้ว' + (days>0 ? ` — หมดเวลาใน ${days} วัน` : ' — ไม่จำกัดเวลา'),'success',4000);
        }
      } catch(e){
        console.error(e);
        if (String(e).includes('permission')) return rulesHint('ปักหมุด');
        toast('ปักหมุดไม่สำเร็จ','error');
      }
    }

    function renderTableRows(items){
      const wrap = byId('tableWrap');
      if (!wrap) return;
      wrap.innerHTML = '';
      const tbl = create('table');
      const thead = create('thead');
      thead.innerHTML = '<tr><th>หัวข้อ</th><th>ประเภท</th><th>โหมด</th><th>สถานะ</th><th>ราคา</th><th>👁</th><th>โพสต์เมื่อ</th><th></th></tr>';
      tbl.appendChild(thead);
      const tbody = create('tbody');
      if (!items.length){
        const tr = create('tr');
        tr.appendChild(create('td', { colspan:'8', class:'small muted', text:'— ไม่พบรายการ —' }));
        tbody.appendChild(tr);
      }
      items.forEach(it => {
        const tr = create('tr');
        tr.appendChild(create('td', { text: it.title || '-' }));
        tr.appendChild(create('td', { text: it.type || '-' }));
        const tdMode = create('td'); tdMode.appendChild(create('span', { class:'badge mode-'+(it.listingMode==='rent'?'rent':'sale'), text: MODE_LABEL[it.listingMode]||'ขาย' })); tr.appendChild(tdMode);
        // เปลี่ยนสถานะเร็วจากในตาราง
        const tdStatus = create('td');
        const sel = create('select', { class:'input status-sel' });
        ['available','reserved','sold','draft'].forEach(s => sel.appendChild(create('option', { value:s, text: STATUS_LABEL[s] })));
        sel.value = it.status || 'available';
        sel.addEventListener('change', () => quickStatus(it, sel.value));
        tdStatus.appendChild(sel);
        tr.appendChild(tdStatus);
        tr.appendChild(create('td', { text: baht(it.price) + (it.priceUnit?' ('+it.priceUnit+')':'') }));
        tr.appendChild(create('td', { text: String(+it.views||0) }));
        tr.appendChild(create('td', { class:'small', text: fmtPostDate(it) || '-' }));
        const tdAct = create('td', { class:'btn-row' });
        tdAct.appendChild(create('button', {
          class:'btn btn-ghost' + (it.pinned ? ' pin-on' : ''),
          title: it.pinned ? 'เลิกปักหมุด' : 'ปักหมุด (แสดงบนสุด)',
          text: it.pinned ? '📌 ปักหมุดแล้ว' : '📌 ปักหมุด',
          onclick: () => togglePin(it)
        }));
        tdAct.appendChild(create('button', { class:'btn btn-ghost', text:'แก้ไข', onclick: () => openEdit(it) }));
        tdAct.appendChild(create('button', { class:'btn btn-ghost', text:'ก๊อปปี้', onclick: () => duplicateListing(it) }));
        tr.appendChild(tdAct);
        tbody.appendChild(tr);
      });
      tbl.appendChild(tbody);
      wrap.appendChild(tbl);
    }

    function renderTableFiltered(){ renderTableRows(adminFilterSort()); }

    byId('adminSearch')?.addEventListener('input', renderTableFiltered);
    byId('adminSort')?.addEventListener('change', renderTableFiltered);

    db.collection('listings').orderBy('createdAt','desc').onSnapshot(snap => {
      adminItems = snap.docs.map(d => ({ id:d.id, ...d.data() }));
      renderStats(adminItems);
      renderMarkers(adminItems);
      renderTableFiltered();
    }, err => {
      console.error(err);
      if (String(err).includes('permission')) rulesHint('โหลดรายการ');
    });

    /* Lightbox (admin can also use) */
    setupLightbox();
  }

})();
