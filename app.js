
const APP_VERSION = "v2.0.3";
const APP_DATE = "2026-01-06";

const STORAGE_KEY_OBJECTS = "vajagman_objects_v3";
const STORAGE_KEY_CURRENT = "vajagman_current_id_v3";
const STORAGE_KEY_AUTOMODE = "vajagman_auto_open_enabled_v3";
const STORAGE_KEY_AUTORADIUS = "vajagman_auto_open_radius_v3";
const STORAGE_KEY_ADDR_SYSTEM = "vajagman_addr_system_ids_v3";
const AUTO_COOLDOWN_MS = 15000;

// Geocoding language control (avoid browser UI language affecting results).
const STORAGE_KEY_GEO_LANG = "vajagman_geo_lang_v1";
function getGeoLang(){
  const v = (localStorage.getItem(STORAGE_KEY_GEO_LANG) || "lv").trim();
  // allow values like "lv", "lv-LV", "en", "en-US"
  return v || "lv";
}


// Fields: address is handled separately (rendered above mini map), but still stored in object.
const schema = [
  { key: "DURVJU_KODS_PIEKLUVE", label: "DURVJU KODS/PIEKĻUVE", type: "textarea" },
  { key: "PIEKLUVES_KONTAKTI", label: "PIEKĻUVES KONTAKTI", type: "textarea" },
  { key: "PANELIS_MARKA", label: "PANELIS MARKA", type: "textarea" },
  { key: "PAROLE1", label: "PAROLE1", type: "textarea" },
  { key: "PAROLE2", label: "PAROLE2", type: "textarea" },
  { key: "PAROLE3", label: "PAROLE3", type: "textarea" },
  { key: "REMOTEPAROLE", label: "REMOTEPAROLE", type: "textarea" },
  { key: "OBJEKTA_NR", label: "OBJEKTA NR", type: "textarea" },
  { key: "PIEZIMES1", label: "PIEZĪMES1", type: "textarea" },
  { key: "PIEZIMES2", label: "PIEZĪMES2", type: "textarea" },
  { key: "KONFIGURACIJA", label: "KONFIGURĀCIJA", type: "textarea" },
  { key: "LAT", label: "LAT (koordinātes)", type: "textarea" },
  { key: "LNG", label: "LNG (koordinātes)", type: "textarea" },
];

function $(id){ return document.getElementById(id); }
function uid(){ return Math.random().toString(16).slice(2) + Date.now().toString(16); }

function loadJson(key, fallback){
  try {
    const raw = localStorage.getItem(key);
    if (raw) return JSON.parse(raw);
  } catch {}
  return fallback;
}
function saveJson(key, val){ localStorage.setItem(key, JSON.stringify(val)); }

function setStatus(msg, dirty=false){
  const el = $("status");
  if (!el) return;
  el.textContent = msg;
  el.classList.toggle("dirty", !!dirty);
}
function setMapStatus(msg){ $("mapStatus").textContent = msg; }

let objects = [];
let currentId = null;
let working = null;          // working copy (may be new)
let workingIsNew = false;
let dirtyFields = new Set(); // keys changed (incl. ADRESE_LOKACIJA)
let addrSystemIds = new Set();

function loadObjects(){ return Array.isArray(loadJson(STORAGE_KEY_OBJECTS, [])) ? loadJson(STORAGE_KEY_OBJECTS, []) : []; }
function saveObjects(){ saveJson(STORAGE_KEY_OBJECTS, objects); }
function saveCurrentId(id){ if (id) localStorage.setItem(STORAGE_KEY_CURRENT, id); }
function loadCurrentId(){
  const id = localStorage.getItem(STORAGE_KEY_CURRENT);
  if (id && objects.some(o => o.id === id)) return id;
  return objects[0]?.id ?? null;
}
function loadAddrSystemIds(){
  const arr = loadJson(STORAGE_KEY_ADDR_SYSTEM, []);
  return new Set(Array.isArray(arr) ? arr : []);
}
function saveAddrSystemIds(){ saveJson(STORAGE_KEY_ADDR_SYSTEM, Array.from(addrSystemIds)); }

function getSavedById(id){ return objects.find(o => o.id === id) || null; }

function parseLatLng(o){
  const lat = Number(String(o.LAT || "").replace(",", "."));
  const lng = Number(String(o.LNG || "").replace(",", "."));
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return { lat, lng };
}

function titleFromRecord(o){
  const adr = String(o?.ADRESE_LOKACIJA || "").trim();
  const code = String(o?.DURVJU_KODS_PIEKLUVE || "").trim();
  const oneLineCode = code.split(/\\r?\\n/)[0].trim();
  const t = oneLineCode ? (adr + ", " + oneLineCode).trim() : adr;
  return t || "—";
}

// IMPORTANT: record title in header is based on SAVED record only.
// - New (unsaved) => "—"
// - Existing => derive from saved snapshot
function updateCtxTitle(){
  if (workingIsNew || !currentId){
    $("ctxTitle").textContent = "—";
    return;
  }
  const saved = getSavedById(currentId);
  $("ctxTitle").textContent = titleFromRecord(saved);
}

function applySystemAddressStyle(){ 
  const wrap = document.querySelector('.field.addressStandalone');
  if (!wrap) return;
  const isSystem = (!workingIsNew && currentId && addrSystemIds.has(currentId)) || (workingIsNew && working && working.__addrSystem === true);
  wrap.classList.toggle("system", !!isSystem);
}

// Save button state machine:
// - disabled if no changes (dirtyFields empty)
// - for NEW: also disabled if all fields empty (avoid empty record)
function hasMeaningfulData(obj){
  if (!obj) return false;
  const keys = ["ADRESE_LOKACIJA","ADRESES_LOKACIJAS_PIEZIMES","DURVJU_KODS_PIEKLUVE","PIEKLUVES_KONTAKTI","PANELIS_MARKA","PAROLE1","PAROLE2","PAROLE3","REMOTEPAROLE","OBJEKTA_NR","PIEZIMES1","PIEZIMES2","KONFIGURACIJA","LAT","LNG"];
  return keys.some(k => String(obj[k] || "").trim().length > 0);
}



function wireHeaderActions(){
  const btnSave = $("btnSave");
  const btnNew = $("btnNew");
  const btnVal = $("btnValidateAddress");
  const btnGps = $("btnGps");

  if (btnSave) btnSave.onclick = saveWorking;
  if (btnNew) btnNew.onclick = createNewRecord;
  if (btnVal) btnVal.onclick = validateAddress;
  if (btnGps) btnGps.onclick = fillFromGPS;

  refreshSaveButton();
}

function updateHdrActionBar(){
  const bar = $("hdrActionBar");
  if (!bar) return;
  bar.classList.toggle("hidden", activeTab !== "record");
}

function refreshSaveButton(){
  const btn = $("btnSave");
  if (!btn) return;
  const isDirty = dirtyFields.size > 0;
  const canSave = isDirty && (!workingIsNew || hasMeaningfulData(working));
  btn.disabled = !canSave;
  btn.classList.toggle("primary", canSave);
  // When not dirty: show "Saglabāts." if existing record; for new empty show "Nav ierakstu..." handled elsewhere
  if (!isDirty && !workingIsNew && currentId) setStatus("Saglabāts.", false);
  if (isDirty) setStatus("Nesaglabātas izmaiņas — nospied SAGLABĀT.", true);
}

function markDirty(key){
  dirtyFields.add(key);
  // mark field wrapper dirty
  const wrap = document.querySelector(`.field[data-key="${CSS.escape(key)}"]`);
  if (wrap) wrap.classList.add("dirty");
  refreshSaveButton();
}

function clearDirtyUI(){
  document.querySelectorAll(".field.dirty").forEach(el => el.classList.remove("dirty"));
  dirtyFields.clear();
  refreshSaveButton();
}

function blankObject(){
  const o = { id: uid(), ADRESE_LOKACIJA: "" };
  for (const f of schema) o[f.key] = "";
  return o;
}

function setWorking(o, isNew){
  working = o;
  workingIsNew = !!isNew;
  dirtyFields.clear();

  // address input
  $("ADRESE_LOKACIJA").value = String(working.ADRESE_LOKACIJA || "");
  // clear dirty state on address field wrapper
  document.querySelector('.field.addressStandalone')?.classList.remove("dirty");

  buildForm($("formRoot"), working);
  applySystemAddressStyle();
  updateCtxTitle();

  if (workingIsNew) setStatus("Jauns ieraksts (nav saglabāts).");
  else setStatus("Saglabāts.");
  refreshSaveButton();
  updateMiniMap();
}

function discardUnsavedChangesIfNeeded(){
  if (dirtyFields.size === 0) return;

  if (workingIsNew){
    // discard completely (discipline)
    working = null;
    workingIsNew = false;
    dirtyFields.clear();
    setStatus("Nesaglabāts JAUNS ieraksts atmests.", false);

    if (objects.length){
      currentId = currentId || objects[0].id;
      setWorking(structuredClone(getSavedById(currentId)), false);
    } else {
      createNewRecord();
      // but don't mark dirty
      dirtyFields.clear();
      refreshSaveButton();
      setStatus("Nav ierakstu. Izveido jaunu un SAGLABĀT.");
    }
    return;
  }

  // existing record: revert
  const saved = getSavedById(currentId);
  if (saved){
    setWorking(structuredClone(saved), false);
    setStatus("Nesaglabātas izmaiņas atmestas.", false);
  }
}

function saveWorking(){
  if (!working) return;

  // no-op if should not save
  if (dirtyFields.size === 0) return;
  if (workingIsNew && !hasMeaningfulData(working)) return;

  // system address marker persists only if still flagged
  if (working.__addrSystem === true) {
    // keep for save below
  }

  if (workingIsNew){
    delete working.__addrSystem;
    objects.unshift(structuredClone(working));
    saveObjects();
    currentId = working.id;
    saveCurrentId(currentId);
    workingIsNew = false;
  } else {
    const idx = objects.findIndex(o => o.id === working.id);
    if (idx >= 0){
      objects[idx] = structuredClone(working);
      saveObjects();
    }
  }

  // address system tracking
  if (!workingIsNew && currentId){
    if (working.__addrSystem === true) addrSystemIds.add(currentId);
    saveAddrSystemIds();
  }

  clearDirtyUI();
  updateCtxTitle(); // title appears/updates ONLY after save
  refreshCatalog();
  refreshMarkers();
  updateMiniMap();
  setStatus("Saglabāts.", false);
}

function createNewRecord(){
  const o = blankObject();
  o.__addrSystem = false;
  currentId = null; // not in catalog until save
  setWorking(o, true);
  dirtyFields.clear();
  updateCtxTitle(); // shows —
  refreshSaveButton();
  setStatus("Jauns ieraksts (nav saglabāts). Aizpildi un nospied SAGLABĀT.");
}

function buildForm(root, obj){
  root.innerHTML = "";

  for (const f of schema){
    const wrap = document.createElement("div");
    wrap.className = "field";
    wrap.dataset.key = f.key;

    const label = document.createElement("label");
    label.textContent = f.label;
    label.htmlFor = f.key;

    // VAJAGMAN v2: one input type across the app = textarea (with autogrow)
    const input = document.createElement("textarea");
    input.id = f.key;
    input.className = "input autogrow";
    input.rows = 1;
    input.spellcheck = false;

    // Field-specific behavior
    if (f.key === "PIEKLUVES_KONTAKTI"){
      // Digits only, max 15
      input.inputMode = "numeric";
      input.autocomplete = "tel";
      input.placeholder = "tālrunis (tikai cipari)";
    }

    input.value = String((obj && obj[f.key] != null) ? obj[f.key] : "");

    // Row layout (optional call button)
    let row = null;
    let callBtn = null;
    if (f.key === "PIEKLUVES_KONTAKTI"){
      row = document.createElement("div");
      row.className = "fieldRow";

      callBtn = document.createElement("button");
      callBtn.type = "button";
      callBtn.className = "btn call";
      callBtn.textContent = "ZVANS";
      callBtn.disabled = true;

      callBtn.addEventListener("click", () => {
        const num = String(input.value || "").trim();
        if (!num) return;
        // Use tel: scheme (mobile will open dialer)
        window.location.href = "tel:" + num;
      });

      row.appendChild(input);
      row.appendChild(callBtn);
    }

    input.addEventListener("input", () => {
      if (!working) return;

      if (f.key === "PIEKLUVES_KONTAKTI"){
        const cleaned = String(input.value || "").replace(/\D+/g, "").slice(0, 15);
        if (cleaned !== input.value) input.value = cleaned;
        if (callBtn) callBtn.disabled = cleaned.length === 0;
      }

      working[f.key] = input.value;
      syncDirtyForKey(f.key);
    });

    wrap.appendChild(label);
    if (row) wrap.appendChild(row);
    else wrap.appendChild(input);

    root.appendChild(wrap);
  }

  // Ensure autogrow applies to the newly created fields immediately
  try{ wireAutoGrow(); }catch(e){}
}

// Address input (special)
function wireAddressInput(){
  const inp = $("ADRESE_LOKACIJA");
  inp.addEventListener("input", () => {
    if (!working) return;
    working.ADRESE_LOKACIJA = inp.value;
    // if user edits manually, drop system marker
    if (workingIsNew){
      working.__addrSystem = false;
    } else if (currentId) {
      addrSystemIds.delete(currentId);
      saveAddrSystemIds();
    }
    applySystemAddressStyle();

    // mark dirty UI on wrapper
    document.querySelector('.field.addressStandalone')?.classList.add("dirty");
    markDirty("ADRESE_LOKACIJA");
  });
}

// Geocoding (Nominatim)
async function geocodeAddress(address){
  const q = encodeURIComponent(address || "");
  const lang = getGeoLang();
  const url = `https://nominatim.openstreetmap.org/search?format=json&q=${q}&limit=1&accept-language=${encodeURIComponent(lang)}`;
  const res = await fetch(url, { headers: { "Accept": "application/json", "Accept-Language": lang } });
  if (!res.ok) throw new Error("Geocoding kļūda: " + res.status);
  const arr = await res.json();
  if (!arr?.length) return null;
  return { lat: Number(arr[0].lat), lng: Number(arr[0].lon) };
}

async function reverseGeocode(lat, lng){
  const lang = getGeoLang();
  const url = `https://nominatim.openstreetmap.org/reverse?format=json&lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lng)}&zoom=18&addressdetails=1&accept-language=${encodeURIComponent(lang)}`;
  const res = await fetch(url, { headers: { "Accept": "application/json", "Accept-Language": lang } });
  if (!res.ok) throw new Error("Reverse geocoding kļūda: " + res.status);
  const data = await res.json();
  const a = data && data.address ? data.address : {};
  const road = a.road || a.pedestrian || a.footway || a.cycleway || "";
  const house = a.house_number || "";
  const city = a.city || a.town || a.village || a.municipality || "";
  const county = a.county || "";
  const state = a.state || "";
  let line1 = [road, house].filter(Boolean).join(" ").trim();
  let line2 = city || county || state || "";
  let out = [line1, line2].filter(Boolean).join(", ").trim();
  if (!out) out = (data && data.display_name) ? String(data.display_name) : "";
  return out;
}

// Address validation (writes pretty address ALL CAPS + LAT/LNG)
async function fillFromGPS(){
  if (!working) return;
  try{
    setStatus("GPS: nosaku lokāciju…", false);
    const me = await getCoords();
    working.LAT = String(me.lat);
    working.LNG = String(me.lng);
    $("LAT").value = working.LAT;
    $("LNG").value = working.LNG;

    let pretty = "";
    try { pretty = await reverseGeocode(me.lat, me.lng); } catch {}
    if (pretty){
      working.ADRESE_LOKACIJA = pretty.toUpperCase();
      $("ADRESE_LOKACIJA").value = working.ADRESE_LOKACIJA;

      if (workingIsNew) working.__addrSystem = true;
      else if (currentId) { addrSystemIds.add(currentId); saveAddrSystemIds(); }
      applySystemAddressStyle();

      document.querySelector('.field.addressStandalone')?.classList.add("dirty");
      markDirty("ADRESE_LOKACIJA");
    }

    markDirty("LAT");
    markDirty("LNG");

    refreshMarkers();
    updateMiniMap();
    setStatus("GPS: adrese + koordinātes ieliktas. Nospied SAGLABĀT.", true);
  }catch{
    setStatus("GPS: neizdevās (atļaujas / GPS / internets).", true);
  }
}

async function validateAddress(){
  if (!working) return;
  const address = String(working.ADRESE_LOKACIJA || "").trim();
  if (!address){
    setStatus("Nav adreses, ko validēt.", true);
    return;
  }
  try {
    setStatus("Validēju adresi un meklēju koordinātes…", false);
    const geo = await geocodeAddress(address);
    if (!geo){
      setStatus("Validācija: koordinātes neatradu (precizē adresi).", true);
      return;
    }
    working.LAT = String(geo.lat);
    working.LNG = String(geo.lng);

    let pretty = "";
    try { pretty = await reverseGeocode(geo.lat, geo.lng); } catch {}
    const finalAddr = (pretty || address).trim();
    working.ADRESE_LOKACIJA = finalAddr.toUpperCase();
    $("ADRESE_LOKACIJA").value = working.ADRESE_LOKACIJA;

    // mark system
    if (workingIsNew) working.__addrSystem = true;
    else if (currentId) { addrSystemIds.add(currentId); saveAddrSystemIds(); }

    applySystemAddressStyle();

    // reflect coords fields if visible
    $("LAT").value = working.LAT;
    $("LNG").value = working.LNG;

    markDirty("LAT");
    markDirty("LNG");
    // Address is changed by system: still dirty until user saves
    document.querySelector('.field.addressStandalone')?.classList.add("dirty");
    markDirty("ADRESE_LOKACIJA");

    refreshMarkers();
    updateMiniMap();
    setStatus("Adreses validācija pabeigta + koordinātes ieliktas. Nospied SAGLABĀT.", true);
  } catch {
    setStatus("Adreses validācija neizdevās (internets / serviss).", true);
  }
}

// Distance / GPS
function haversineMeters(lat1, lon1, lat2, lon2){
  const R = 6371000;
  const toRad = (x) => (x * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat/2) * Math.sin(dLat/2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
    Math.sin(dLon/2) * Math.sin(dLon/2);
  return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

function getCoords(){
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error("Geolocation nav pieejams."));
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude, acc: pos.coords.accuracy }),
      (err) => reject(err),
      { enableHighAccuracy: true, timeout: 12000, maximumAge: 5000 }
    );
  });
}

function findNearestTo(lat, lng){
  let best = null;
  for (const o of objects){
    const c = parseLatLng(o);
    if (!c) continue;
    const d = haversineMeters(lat, lng, c.lat, c.lng);
    if (!best || d < best.d) best = { o, d, c };
  }
  return best;
}

// Mini map
let miniMap = null;
let miniMarker = null;
function ensureMiniMap(){
  if (miniMap) return;
  miniMap = L.map("miniMap", { zoomControl: false, attributionControl:false, dragging:true, scrollWheelZoom:false, doubleClickZoom:false });
  miniMap.setView([56.9496, 24.1052], 12);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19 }).addTo(miniMap);
}

function updateMiniMap(){
  ensureMiniMap();
  setTimeout(() => miniMap.invalidateSize(), 50);

  if (!working) return;
  const c = parseLatLng(working);
  if (!c){
    if (miniMarker) { miniMap.removeLayer(miniMarker); miniMarker = null; }
    miniMap.setView([56.9496, 24.1052], 12);
    return;
  }
  if (!miniMarker) miniMarker = L.marker([c.lat, c.lng]).addTo(miniMap);
  else miniMarker.setLatLng([c.lat, c.lng]);
  miniMap.setView([c.lat, c.lng], 16);
}

// Main map tab
let map = null;
let markersLayer = null;
let meMarker = null;

function ensureMap(){
  if (map) return;
  map = L.map("map", { zoomControl: true });
  map.setView([56.9496, 24.1052], 12);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, attribution: "&copy; OpenStreetMap" }).addTo(map);
  markersLayer = L.layerGroup().addTo(map);

  // long-press/right click to set coords to working record
  map.on("contextmenu", (e) => {
    if (!working) return;
    working.LAT = String(e.latlng.lat);
    working.LNG = String(e.latlng.lng);
    $("LAT").value = working.LAT;
    $("LNG").value = working.LNG;
    markDirty("LAT");
    markDirty("LNG");
    refreshMarkers();
    updateMiniMap();
    setMapStatus(`Ielikts LAT/LNG: ${e.latlng.lat.toFixed(6)}, ${e.latlng.lng.toFixed(6)}. Nospied SAGLABĀT.`);
  });
}

function escapeHtml(s){ return String(s).replace(/[&<>"']/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"}[c])); }

function objectPopupHtml(o){
  const title = titleFromRecord(o);
  const lines = [
    `<div style="font-weight:900;margin-bottom:6px;">${escapeHtml(title)}</div>`,
    o.ADRESES_LOKACIJAS_PIEZIMES ? `<div><b>Piezīmes:</b> ${escapeHtml(o.ADRESES_LOKACIJAS_PIEZIMES)}</div>` : "",
    o.DURVJU_KODS_PIEKLUVE ? `<div><b>Kods:</b> ${escapeHtml(o.DURVJU_KODS_PIEKLUVE)}</div>` : "",
    o.PIEKLUVES_KONTAKTI ? `<div><b>Kontakti:</b> ${escapeHtml(o.PIEKLUVES_KONTAKTI)}</div>` : "",
    `<div style="margin-top:8px;display:flex;gap:8px;flex-wrap:wrap;">` +
      `<button data-open="${o.id}" style="padding:6px 10px;border-radius:10px;border:1px solid #1f2a44;background:#1e293b;color:#e2e8f0;font-weight:800;">Atvērt</button>` +
    `</div>`
  ].filter(Boolean);
  return `<div style="font-size:13px;line-height:1.25">${lines.join("")}</div>`;
}

function refreshMarkers(){
  if (!map || !markersLayer) return;
  markersLayer.clearLayers();
  for (const o of objects){
    const c = parseLatLng(o);
    if (!c) continue;
    const m = L.marker([c.lat, c.lng]).addTo(markersLayer);
    m.bindPopup(objectPopupHtml(o), { maxWidth: 320 });
    m.on("popupopen", (e) => {
      const node = e.popup.getElement();
      node?.querySelectorAll("button[data-open]").forEach(btn => {
        btn.onclick = () => openRecordById(btn.getAttribute("data-open"));
      });
    });
  }
}

function openRecordById(id){
  const saved = getSavedById(id);
  if (!saved) return;
  currentId = id;
  saveCurrentId(currentId);
  setWorking(structuredClone(saved), false);
  switchTab("record");
}

async function centerOnMe(){
  setMapStatus("Nosaku lokāciju…");
  const me = await getCoords();
  ensureMap();
  if (!meMarker) {
    meMarker = L.circleMarker([me.lat, me.lng], { radius: 8 }).addTo(map);
  } else meMarker.setLatLng([me.lat, me.lng]);
  map.setView([me.lat, me.lng], 16);
  setMapStatus(`Tu: ${me.lat.toFixed(5)}, ${me.lng.toFixed(5)} (±${Math.round(me.acc)}m)`);
  return me;
}

async function findNearestToMeAndFocus(){
  const me = await centerOnMe();
  const best = findNearestTo(me.lat, me.lng);
  if (!best) { setMapStatus("Nav objektu ar koordinātēm (LAT/LNG)."); return; }
  map.setView([best.c.lat, best.c.lng], 17);
  setMapStatus(`Tuvākais: ~${Math.round(best.d)}m.`);
}

// Auto-open nearest (opens record automatically)
let watchId = null;
let lastAutoSwitchAt = 0;
function isAutoEnabled(){ return localStorage.getItem(STORAGE_KEY_AUTOMODE) === "1"; }
function setAutoEnabled(on){ localStorage.setItem(STORAGE_KEY_AUTOMODE, on ? "1" : "0"); }
function getAutoRadius(){ const n = Number(localStorage.getItem(STORAGE_KEY_AUTORADIUS)); return Number.isFinite(n) && n>=20 ? n : 80; }
function setAutoRadius(n){ localStorage.setItem(STORAGE_KEY_AUTORADIUS, String(n)); }

function maybeStartAutoWatch(){
  if (!isAutoEnabled()) return;
  if (watchId !== null) return;
  if (!navigator.geolocation) { setMapStatus("Auto: geolocation nav pieejams."); return; }
  watchId = navigator.geolocation.watchPosition((pos) => {
    const now = Date.now();
    if (now - lastAutoSwitchAt < AUTO_COOLDOWN_MS) return;
    const me = { lat: pos.coords.latitude, lng: pos.coords.longitude };
    const best = findNearestTo(me.lat, me.lng);
    if (!best) return;
    const radius = getAutoRadius();
    if (best.d > radius) return;

    lastAutoSwitchAt = now;

    // discard unsaved if needed (discipline)
    if (activeTab === "record" && dirtyFields.size > 0) discardUnsavedChangesIfNeeded();

    currentId = best.o.id;
    saveCurrentId(currentId);
    setWorking(structuredClone(getSavedById(currentId)), false);
    switchTab("record");
    setStatus(`Auto: atvērts tuvākais (~${Math.round(best.d)}m).`);
  }, () => {
    setMapStatus("Auto: lokācija nav pieejama (atļaujas / GPS).");
  }, { enableHighAccuracy: true, maximumAge: 5000, timeout: 12000 });
}

function stopAutoWatch(){
  if (watchId === null) return;
  try { navigator.geolocation.clearWatch(watchId); } catch {}
  watchId = null;
}

// Tabs
let activeTab = "record";
function switchTab(name){
  if (activeTab === "record" && name !== "record") discardUnsavedChangesIfNeeded();

  activeTab = name;
  updateSubHeaders();
  document.querySelectorAll(".panel").forEach(p => p.classList.add("hidden"));
  $("tab-" + name).classList.remove("hidden");
  document.querySelectorAll(".tab").forEach(t => t.classList.toggle("active", t.dataset.tab === name));

  if (name === "map") {
    ensureMap();
    setTimeout(() => map.invalidateSize(), 50);
    refreshMarkers();
    maybeStartAutoWatch();
  } else {
    stopAutoWatch();
  }
  if (name === "catalog") refreshCatalog();
}

// Catalog
function refreshCatalog(){
  const root = $("listRoot");
  const q = ($("search").value || "").toLowerCase().trim();
  const list = objects.filter(o => {
    const t = `${o.OBJEKTA_NR||""} ${o.ADRESE_LOKACIJA||""}`.toLowerCase();
    return !q || t.includes(q);
  });

  root.innerHTML = "";
  if (!list.length) {
    const empty = document.createElement("div");
    empty.className = "item";
    empty.innerHTML = `<div class="itemTitle">Nav ierakstu</div><div class="itemMeta">IERAKSTS → JAUNS → SAGLABĀT.</div>`;
    root.appendChild(empty);
    return;
  }

  for (const o of list){
    const el = document.createElement("div");
    el.className = "item";
    const top = document.createElement("div");
    top.className = "itemTop";

    const left = document.createElement("div");
    left.style.flex = "1";
    left.style.minWidth = "0";

    const title = document.createElement("div");
    title.className = "itemTitle";
    title.textContent = titleFromRecord(o);

    const meta = document.createElement("div");
    meta.className = "itemMeta";
    const c = parseLatLng(o);
    meta.textContent = c ? `LAT/LNG: ${c.lat.toFixed(6)}, ${c.lng.toFixed(6)}` : "LAT/LNG: nav";

    left.appendChild(title);
    left.appendChild(meta);

    const btnOpen = document.createElement("button");
    btnOpen.className = "btn primary";
    btnOpen.textContent = "ATVĒRT";
    btnOpen.onclick = () => openRecordById(o.id);

    top.appendChild(left);
    top.appendChild(btnOpen);

    const btns = document.createElement("div");
    btns.className = "itemBtns";

    const btnMap = document.createElement("button");
    btnMap.className = "btn";
    btnMap.textContent = "KARTE";
    btnMap.onclick = () => {
      switchTab("map");
      ensureMap();
      refreshMarkers();
      const c = parseLatLng(o);
      if (c) map.setView([c.lat, c.lng], 17);
    };

    const btnDel = document.createElement("button");
    btnDel.className = "btn danger";
    btnDel.textContent = "DZĒST";
    btnDel.onclick = () => {
      if (!confirm("Dzēst ierakstu?")) return;
      objects = objects.filter(x => x.id !== o.id);
      saveObjects();
      addrSystemIds.delete(o.id);
      saveAddrSystemIds();
      if (currentId === o.id) currentId = objects[0]?.id ?? null;
      refreshCatalog();
      refreshMarkers();
      if (currentId) setWorking(structuredClone(getSavedById(currentId)), false);
      else createNewRecord();
      setStatus("Dzēsts.");
    };

    btns.appendChild(btnMap);
    btns.appendChild(btnDel);

    el.appendChild(top);
    el.appendChild(btns);

    el.addEventListener("click", (ev) => {
      if (ev.target && ev.target.closest("button")) return;
      openRecordById(o.id);
    });

    root.appendChild(el);
  }
}

function exportJson(){
  const box = $("exportBox");
  box.value = JSON.stringify(objects, null, 2);
  box.classList.remove("hidden");
  setStatus("JSON eksports sagatavots (nokopē un saglabā).");
}

// PWA
async function registerSW(){
  if (!("serviceWorker" in navigator)) return;
  try { await navigator.serviceWorker.register("./service-worker.js"); } catch {}
}

document.addEventListener("DOMContentLoaded", () => {
  objects = loadObjects();
  addrSystemIds = loadAddrSystemIds();
  currentId = loadCurrentId();

  wireHeaderActions();
  updateHdrActionBar();

  wireHeaderActions();
  updateHdrActionBar();

  // Address wire-up
  wireAddressInput();

  if (currentId) {
    setWorking(structuredClone(getSavedById(currentId)), false);
  } else {
    createNewRecord();
    dirtyFields.clear();
    refreshSaveButton();
    setStatus("Nav ierakstu. Izveido jaunu un SAGLABĀT.");
  }

  // Tabs
  document.querySelectorAll(".tab").forEach(btn => btn.addEventListener("click", () => switchTab(btn.dataset.tab)));

  // Map tab buttons
  $("btnCenterMe").addEventListener("click", () => centerOnMe());
  $("btnFindNearest").addEventListener("click", () => findNearestToMeAndFocus());

  // Validation button in map block (mini map header)
  
  // Auto settings
  $("autoOpenToggle").checked = isAutoEnabled();
  $("autoRadius").value = String(getAutoRadius());
  $("autoOpenToggle").addEventListener("change", () => {
    setAutoEnabled($("autoOpenToggle").checked);
    if ($("autoOpenToggle").checked) maybeStartAutoWatch();
    else stopAutoWatch();
  });
  $("autoRadius").addEventListener("change", () => {
    const n = Number($("autoRadius").value);
    setAutoRadius(Number.isFinite(n) ? n : 80);
  });

  // Catalog
  $("search").addEventListener("input", refreshCatalog);
  $("btnExport").addEventListener("click", exportJson);

  // Mini map
  updateMiniMap();

  registerSW();
});

function updateSubHeaders(){
  const rec=document.querySelector('.hdr-sub-record');
  const map=document.querySelector('.hdr-sub-map');
  const cat=document.querySelector('.hdr-sub-catalog');
  if(!rec||!map||!cat) return;
  rec.classList.toggle('hidden',activeTab!=='record');
  map.classList.toggle('hidden',activeTab!=='map');
  cat.classList.toggle('hidden',activeTab!=='catalog');
}

function autoGrow(el){
  if(!el) return;
  const min = 48;
  el.style.height = "auto";
  const h = Math.max(min, el.scrollHeight);
  el.style.height = h + "px";
}
function wireAutoGrow(){
  document.querySelectorAll('textarea.autogrow').forEach(el=>{
    autoGrow(el);
    el.addEventListener('input', ()=>autoGrow(el));
  });
}

wireAutoGrow();

document.addEventListener('DOMContentLoaded', ()=>{
  if (typeof wireAutoGrow === 'function') wireAutoGrow();
});