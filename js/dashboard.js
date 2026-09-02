const statusEl = document.getElementById('status');
const deviceCountEl = document.getElementById('deviceCount');
const lastUpdateEl = document.getElementById('lastUpdate');
const refreshBtn = document.getElementById('refreshBtn');
const centerBtn = document.getElementById('centerBtn');
const fenceBtn = document.getElementById('fenceBtn');
const settingsBtn = document.getElementById('settingsBtn');
const historyBtn = document.getElementById('historyBtn');
const deviceListEl = document.getElementById('deviceList');
const searchBox = document.getElementById('searchBox');
const ddNameEl = document.getElementById('ddName');
const ddAddrEl = document.getElementById('ddAddr');
const ddCoordsEl = document.getElementById('ddCoords');
const deviceDetailEl = document.getElementById('deviceDetail');

const COLORS = ['#3498db', '#e74c3c', '#2ecc71', '#f39c12', '#9b59b6', '#e67e22', '#1abc9c', '#c0392b'];

let map = null;
const markers = {};      // device_id -> marker
const paths = {};        // device_id -> polyline
const allPoints = {};    // device_id -> [[lat,lng],...]
const addrCache = {};

// --- new state ---
let fences = [];                 // [{id,name,lat,lng,radius,color}]
const fenceLayers = {};          // id -> L.circle
let eventsCache = [];            // newest first
let eventsBooted = false;
let lastEventTs = 0;
let drawMode = null;             // {stage:'center'|'radius', center, preview}
let settings = { speed_limit_kmh: 0, offline_minutes: 5, history_days: 30 };
let devicesCache = [];           // last /api/locations result for history dropdown

function initMap() {
    map = L.map('map', {
        zoomSnap: 0.5,
        zoomDelta: 0.5,
        maxZoom: 22
    }).setView([14.5995, 120.9842], 12);

    const osm = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19,
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
    });

    const gMap = L.tileLayer('https://mt{s}.google.com/vt/lyrs=m&x={x}&y={y}&z={z}', {
        maxNativeZoom: 22,
        maxZoom: 23,
        subdomains: '0123',
        attribution: '&copy; Google Maps'
    });

    const gSat = L.tileLayer('https://mt{s}.google.com/vt/lyrs=s&x={x}&y={y}&z={z}', {
        maxNativeZoom: 22,
        maxZoom: 23,
        subdomains: '0123',
        attribution: '&copy; Google Satellite'
    });

    const gHybrid = L.tileLayer('https://mt{s}.google.com/vt/lyrs=y&x={x}&y={y}&z={z}', {
        maxNativeZoom: 22,
        maxZoom: 23,
        subdomains: '0123',
        attribution: '&copy; Google Hybrid'
    });

    gMap.addTo(map);

    L.control.layers({
        'Google Map': gMap,
        'Google Satellite': gSat,
        'Google Hybrid': gHybrid,
        'OpenStreetMap': osm
    }, null, { position: 'topleft' }).addTo(map);
}

// ---------------------------------------------------------------------------
// Sound (WebAudio) + Notifications
// ---------------------------------------------------------------------------

let audioCtx = null;
let sirenTimer = null;

function ensureAudio() {
    if (!audioCtx) {
        try { audioCtx = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { return; }
    }
    if (audioCtx.state === 'suspended') audioCtx.resume();
}
document.addEventListener('pointerdown', ensureAudio);

function tone(freq, dur, delay, type, vol) {
    if (!sound_on()) return;
    ensureAudio();
    if (!audioCtx) return;
    const t = audioCtx.currentTime + (delay || 0);
    const o = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    o.type = type || 'sine';
    o.frequency.value = freq;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol || 0.25, t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(audioCtx.destination);
    o.start(t);
    o.stop(t + dur + 0.05);
}

function alertBeep() {
    tone(880, 0.15, 0, 'square', 0.15);
    tone(1100, 0.15, 0.2, 'square', 0.15);
}

function sirenWail() {
    if (!audioCtx) return;
    const t = audioCtx.currentTime;
    const o = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    o.type = 'sawtooth';
    o.frequency.setValueAtTime(600, t);
    o.frequency.linearRampToValueAtTime(1300, t + 0.45);
    o.frequency.linearRampToValueAtTime(600, t + 0.9);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.3, t + 0.05);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.9);
    o.connect(g).connect(audioCtx.destination);
    o.start(t);
    o.stop(t + 0.95);
}

function startSiren() {
    if (!sound_on()) return;
    ensureAudio();
    if (sirenTimer) return;
    sirenWail();
    sirenTimer = setInterval(sirenWail, 950);
}

function stopSiren() {
    if (sirenTimer) { clearInterval(sirenTimer); sirenTimer = null; }
}

function sound_on() { return localStorage.getItem('gt_sound') !== '0'; }

function notifOn() { return localStorage.getItem('gt_notify') !== '0'; }

function sendNotif(title, body) {
    if (!notifOn() || !('Notification' in window)) return;
    if (Notification.permission === 'granted') {
        try { new Notification(title, { body: body, tag: 'gt-' + title }); } catch (e) { }
    }
}

// ---------------------------------------------------------------------------
// Toasts
// ---------------------------------------------------------------------------

function toast(msg, cls) {
    const wrap = document.getElementById('toasts');
    const el = document.createElement('div');
    el.className = 'toast ' + (cls || '');
    el.textContent = msg;
    wrap.appendChild(el);
    setTimeout(() => { el.classList.add('fade'); }, 5500);
    setTimeout(() => { el.remove(); }, 6000);
}

// ---------------------------------------------------------------------------
// SOS alarm
// ---------------------------------------------------------------------------

function sosAlarm(e) {
    const overlay = document.getElementById('sosOverlay');
    document.getElementById('sosInfo').textContent =
        e.device_name + ' — ' + new Date(e.ts).toLocaleTimeString();
    const addrEl = document.getElementById('sosAddr');
    addrEl.textContent = 'Lat: ' + e.data.lat.toFixed(6) + ', Lng: ' + e.data.lng.toFixed(6);
    overlay.style.display = 'flex';
    startSiren();
    sendNotif('🆘 SOS EMERGENCY!', e.message);
    reverseGeocode(e.data.lat, e.data.lng).then(a => { addrEl.textContent = a; });
    overlay.dataset.lat = e.data.lat;
    overlay.dataset.lng = e.data.lng;
}

document.getElementById('sosAck').addEventListener('click', () => {
    document.getElementById('sosOverlay').style.display = 'none';
    stopSiren();
});
document.getElementById('sosLocate').addEventListener('click', () => {
    const ov = document.getElementById('sosOverlay');
    map.setView([parseFloat(ov.dataset.lat), parseFloat(ov.dataset.lng)], 19);
});

// ---------------------------------------------------------------------------
// Events feed
// ---------------------------------------------------------------------------

const EVENT_META = {
    sos: { icon: '🆘', color: '#e74c3c' },
    enter: { icon: '🟢', color: '#2ecc71' },
    exit: { icon: '🔵', color: '#3498db' },
    speeding: { icon: '⚡', color: '#f39c12' },
    offline: { icon: '🟠', color: '#e67e22' },
    online: { icon: '✅', color: '#2ecc71' }
};

function handleEvent(e) {
    if (e.type === 'sos') { sosAlarm(e); return; }
    const m = EVENT_META[e.type] || { icon: '•', color: '#888' };
    toast(m.icon + ' ' + e.message, e.type);
    if (e.type === 'offline' || e.type === 'speeding') alertBeep();
    else tone(660, 0.12, 0, 'sine', 0.12);
    sendNotif(m.icon + ' ' + e.type.charAt(0).toUpperCase() + e.type.slice(1), e.message);
}

function renderEvents() {
    const el = document.getElementById('evtItems');
    if (!el) return;
    if (!eventsCache.length) {
        el.innerHTML = '<div class="evtitem muted">Wala pang events</div>';
        return;
    }
    el.innerHTML = eventsCache.slice(0, 15).map(e => {
        const m = EVENT_META[e.type] || { icon: '•', color: '#888' };
        return `<div class="evtitem" title="${esc(e.message)}">
            <span class="evdot" style="background:${m.color}">${m.icon}</span>
            <span class="evtmsg">${esc(e.message)}</span>
            <span class="evttime">${new Date(e.ts).toLocaleTimeString()}</span>
        </div>`;
    }).join('');
}

async function fetchEvents() {
    try {
        if (!eventsBooted) {
            const res = await fetch('/api/events');
            const list = await res.json();
            eventsCache = Array.isArray(list) ? list : [];
            if (eventsCache.length) lastEventTs = eventsCache[0].ts;
            eventsBooted = true;
            renderEvents();
            return;
        }
        const res = await fetch('/api/events?since=' + lastEventTs + '&limit=200');
        const list = await res.json();
        if (Array.isArray(list) && list.length) {
            lastEventTs = list[list.length - 1].ts;
            eventsCache = list.slice().reverse().concat(eventsCache).slice(0, 50);
            list.forEach(handleEvent);
            renderEvents();
        }
    } catch (e) { /* offline; next poll retries */ }
}

// ---------------------------------------------------------------------------
// Geofences
// ---------------------------------------------------------------------------

function renderFences() {
    Object.values(fenceLayers).forEach(l => map.removeLayer(l));
    Object.keys(fenceLayers).forEach(k => delete fenceLayers[k]);
    fences.forEach(f => {
        const layer = L.circle([f.lat, f.lng], {
            radius: f.radius,
            color: f.color,
            fillColor: f.color,
            fillOpacity: 0.12,
            weight: 2
        }).addTo(map);
        layer.bindTooltip(f.name + ' (' + Math.round(f.radius) + 'm)', {
            permanent: true,
            direction: 'center',
            className: 'fenceLabel'
        });
        layer.bindPopup(`<b>${esc(f.name)}</b><br>Radius: ${Math.round(f.radius)} m`);
        fenceLayers[f.id] = layer;
    });
    renderFenceList();
}

function renderFenceList() {
    const el = document.getElementById('fenceItems');
    if (!el) return;
    if (!fences.length) {
        el.innerHTML = '<div class="evtitem muted">Walang geofence — i-click ang ➕ Geofence</div>';
        return;
    }
    el.innerHTML = fences.map(f => `<div class="evtitem">
        <span class="evdot" style="background:${f.color}"></span>
        <span class="evtmsg">${esc(f.name)} · ${Math.round(f.radius)}m</span>
        <button class="delFence" data-id="${f.id}" title="Delete">🗑</button>
    </div>`).join('');
}

async function loadFences() {
    try {
        const res = await fetch('/api/geofences');
        const list = await res.json();
        if (Array.isArray(list)) { fences = list; renderFences(); }
    } catch (e) { }
}

// --- draw mode: click center, then click edge ---

function setHint(text) {
    const h = document.getElementById('mapHint');
    if (!text) { h.style.display = 'none'; return; }
    h.textContent = text;
    h.style.display = 'block';
}

function cancelDraw() {
    drawMode = null;
    fenceBtn.classList.remove('active');
    map.getContainer().style.cursor = '';
    setHint(null);
}

fenceBtn.addEventListener('click', () => {
    if (drawMode) { cancelDraw(); return; }
    drawMode = { stage: 'center' };
    fenceBtn.classList.add('active');
    map.getContainer().style.cursor = 'crosshair';
    setHint('🟡 Geofence: i-click ang GITNA ng zone (hal. bahay)');
});

map.on('mousemove', e => {
    if (!drawMode || drawMode.stage !== 'radius' || !drawMode.preview) return;
    const r = map.distance(drawMode.center, e.latlng);
    drawMode.preview.setRadius(r);
    setHint('🟡 Radius: ' + Math.round(r) + ' m — i-click ang GILID ng zone');
});

map.on('click', e => {
    if (drawMode) {
        if (drawMode.stage === 'center') {
            drawMode.center = e.latlng;
            drawMode.preview = L.circle(e.latlng, {
                radius: 0, color: '#f1c40f', weight: 2, dashArray: '6 6', fillOpacity: 0.1
            }).addTo(map);
            drawMode.stage = 'radius';
            setHint('🟡 I-click ang GILID ng zone para sa radius');
        } else {
            const radius = map.distance(drawMode.center, e.latlng);
            finishDraw(radius);
        }
        return;
    }
    // normal click: reverse geocode
    reverseGeocode(e.latlng.lat, e.latlng.lng).then(addr => {
        statusEl.textContent = addr;
        statusEl.classList.remove('error');
        statusEl.classList.add('active');
    });
});

document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && drawMode) cancelDraw();
});

async function finishDraw(radius) {
    const center = drawMode.center;
    const preview = drawMode.preview;
    const valid = radius >= 10 && radius <= 100000;
    cancelDraw();
    if (preview) map.removeLayer(preview);
    if (!valid) {
        toast('❌ Radius dapat 10m – 100km. Subukan ulit.', 'error');
        return;
    }
    const name = prompt('Pangalan ng zone (Hal. Bahay, School, Opisina):');
    if (name === null) return;
    if (!name.trim()) { toast('❌ Kailangan ng pangalan.', 'error'); return; }
    try {
        const res = await fetch('/api/geofences', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: name.trim(), lat: center.lat, lng: center.lng, radius })
        });
        if (!res.ok) throw new Error();
        toast('✅ Geofence \'' + name.trim() + '\' created');
        loadFences();
    } catch (err) {
        toast('❌ Hindi ma-save ang geofence', 'error');
    }
}

deviceListEl.addEventListener('click', e => {
    const btn = e.target.closest('.delFence');
    if (!btn) return;
    const id = btn.dataset.id;
    const f = fences.find(x => x.id === id);
    if (f && confirm(`Burahin ang geofence '${f.name}'?`)) {
        fetch('/api/geofences/' + id, { method: 'DELETE' }).then(() => loadFences());
    }
});

// ---------------------------------------------------------------------------
// Settings modal
// ---------------------------------------------------------------------------

function openSettings() {
    document.getElementById('setSpeed').value = settings.speed_limit_kmh || 0;
    document.getElementById('setOffline').value = settings.offline_minutes || 5;
    document.getElementById('setHistoryDays').value = settings.history_days || 30;
    document.getElementById('setSound').checked = sound_on();
    document.getElementById('setNotif').checked = notifOn();
    updateNotifPermLabel();
    document.getElementById('settingsModal').style.display = 'flex';
}

function updateNotifPermLabel() {
    const el = document.getElementById('notifPermState');
    if (!('Notification' in window)) { el.textContent = 'hindi supportado ng browser'; return; }
    el.textContent = {
        'granted': '✅ granted',
        'denied': '⛔ denied (i-enable sa browser settings)',
        'default': '⏳ hindi pa ni-request'
    }[Notification.permission] || Notification.permission;
}

settingsBtn.addEventListener('click', openSettings);
document.getElementById('settingsClose').addEventListener('click', () => {
    document.getElementById('settingsModal').style.display = 'none';
});
document.getElementById('reqNotifBtn').addEventListener('click', () => {
    if ('Notification' in window) Notification.requestPermission().then(updateNotifPermLabel);
});
document.getElementById('settingsSave').addEventListener('click', async () => {
    localStorage.setItem('gt_sound', document.getElementById('setSound').checked ? '1' : '0');
    localStorage.setItem('gt_notify', document.getElementById('setNotif').checked ? '1' : '0');
    if (!sound_on()) stopSiren();
    try {
        const res = await fetch('/api/settings', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                speed_limit_kmh: parseFloat(document.getElementById('setSpeed').value) || 0,
                offline_minutes: parseInt(document.getElementById('setOffline').value) || 5,
                history_days: parseInt(document.getElementById('setHistoryDays').value) || 30
            })
        });
        settings = await res.json();
    } catch (e) { toast('⚠️ Hindi ma-save ang server settings', 'error'); }
    document.getElementById('settingsModal').style.display = 'none';
    toast('⚙️ Settings saved');
});

async function loadSettings() {
    try { settings = await (await fetch('/api/settings')).json(); } catch (e) { }
}

// ---------------------------------------------------------------------------
// Devices (existing behaviour)
// ---------------------------------------------------------------------------

async function reverseGeocode(lat, lng) {
    const key = lat.toFixed(4) + ',' + lng.toFixed(4);
    if (addrCache[key]) return addrCache[key];
    try {
        const url = 'https://geocode.arcgis.com/arcgis/rest/services/World/GeocodeServer/reverseGeocode?f=json&langCode=ph&location=' + lng + ',' + lat;
        const res = await fetch(url);
        const data = await res.json();
        let addr = '';
        if (data.address && data.address.Match_addr) {
            addr = data.address.Match_addr;
            if (data.address.City) addr += ', ' + data.address.City;
            if (data.address.Region) addr += ', ' + data.address.Region;
            if (data.address.Postal) addr += ', ' + data.address.Postal;
        }
        if (!addr) addr = 'Address not found';
        addrCache[key] = addr;
        return addr;
    } catch (e) {
        return 'Address not found';
    }
}

function showDetail(d) {
    const acc = accTxt(d.accuracy);
    ddNameEl.textContent = d.name + ' (' + d.device_id + ')';
    ddCoordsEl.textContent = 'Lat: ' + d.lat.toFixed(6) + '  |  Lng: ' + d.lng.toFixed(6);
    const ddAccEl = document.getElementById('ddAcc');
    if (ddAccEl) {
        ddAccEl.innerHTML = '<i>Kalidad ng lokasyon:</i> ' + accBadge(acc) +
            (acc.type === 'network' ? ' <span class="accnote">(network/wifi — mag-ingat, malaking error)</span>' :
             acc.type === 'fair' ? ' <span class="accnote">(medyo maikli — mag-expect ng ilang bahay na error)</span>' :
             ' <span class="accnote">(GPS - sapat ang tumpak)</span>');
    }
    ddAddrEl.textContent = 'Tinitignan ang address...';
    deviceDetailEl.style.display = 'block';
    reverseGeocode(d.lat, d.lng).then(addr => {
        ddAddrEl.textContent = addr;
    });
}

function colorFor(id, idx) {
    return COLORS[idx % COLORS.length];
}

function ageText(ms) {
    if (ms < 1000) return 'just now';
    const s = Math.floor(ms / 1000);
    if (s < 60) return s + 's ago';
    const m = Math.floor(s / 60);
    if (m < 60) return m + 'm ago';
    return Math.floor(m / 60) + 'h ago';
}

function accTxt(acc) {
    if (acc == null || isNaN(acc)) return { txt: '?', type: 'unknown' };
    const a = Math.round(acc);
    if (a <= 20) return { txt: a + 'm', type: 'gps' };
    if (a <= 100) return { txt: a + 'm', type: 'fair' };
    return { txt: a + 'm', type: 'network' };
}

function accBadge(label) {
    const tag = document.createElement('span');
    tag.dataset.accType = label.type;
    tag.textContent = '±' + label.txt;
    return tag.outerHTML;
}

function updateDevice(d, idx) {
    const c = colorFor(d.device_id, idx);
    const coordTxt = 'Lat: ' + d.lat.toFixed(6) + ' | Lng: ' + d.lng.toFixed(6);
    const acc = accTxt(d.accuracy);
    const accHtml = accBadge(acc);
    const statusTxt = d.last_status || '';

    if (!markers[d.device_id]) {
        markers[d.device_id] = L.marker([d.lat, d.lng], {
            title: d.name,
            icon: L.divIcon({
                html: `<div style="width:14px;height:14px;border-radius:50%;background:${c};border:3px solid #fff;box-shadow:0 0 4px rgba(0,0,0,.4);" title="±${acc.txt} accuracy"></div>`,
                className: ''
            })
        }).addTo(map);
        markers[d.device_id].bindPopup(`<b>${esc(d.name)}</b><br><span style="font-size:.8rem;color:#555">${coordTxt}</span><br>Accuracy: ${accHtml}<br>${statusTxt}<br>Last update: ${ageText(d.age)}`);
        markers[d.device_id].on('click', () => {
            showDetail(d);
            reverseGeocode(d.lat, d.lng).then(addr => {
                markers[d.device_id].setPopupContent(`<b>${esc(d.name)}</b><br><span style="font-size:.8rem;color:#555">${coordTxt}</span><br>Accuracy: ${accHtml}<br>${esc(addr)}<br>${statusTxt}<br>Last update: ${ageText(d.age)}`);
            });
        });
    } else {
        markers[d.device_id].setLatLng([d.lat, d.lng]);
        const cur = markers[d.device_id].getPopup().getContent();
        if (cur.indexOf(coordTxt) < 0 || cur.indexOf('Accuracy') < 0) {
            markers[d.device_id].setPopupContent(`<b>${esc(d.name)}</b><br><span style="font-size:.8rem;color:#555">${coordTxt}</span><br>Accuracy: ${accHtml}<br>${statusTxt}<br>Last update: ${ageText(d.age)}`);
        }
    }

    if (!paths[d.device_id]) {
        paths[d.device_id] = L.polyline([], { color: c, weight: 4, opacity: 0.8 }).addTo(map);
    }
    allPoints[d.device_id] = (d.sees_detail || []).map(p => [p.lat, p.lng]);
    paths[d.device_id].setLatLngs(allPoints[d.device_id]);
}

function esc(s) {
    const div = document.createElement('div');
    div.textContent = s;
    return div.innerHTML;
}

function renderList(devices) {
    let html = '<h3>Devices</h3>';
    devices.forEach((d, idx) => {
        const c = COLORS[idx % COLORS.length];
        const acc = accTxt(d.accuracy);
        html += `<div class="devitem">
            <span class="dot" style="background:${c}"></span>
            <button class="focusBtn" data-id="${esc(d.device_id)}">${esc(d.name)}</button>
            <span class="accbadge-${acc.type}">±${acc.txt}</span>
            <span>${ageText(d.age)}</span>
        </div>`;
    });
    if (!devices.length) html += '<div class="evtitem muted">Wala pang devices</div>';
    html += '<h3>Geofences</h3><div id="fenceItems"></div>';
    html += '<h3>Events</h3><div id="evtItems"></div>';
    deviceListEl.innerHTML = html;
    devices.forEach(d => {
        deviceListEl.querySelector(`.focusBtn[data-id="${CSS.escape(d.device_id)}"]`)
            ?.addEventListener('click', () => {
                map.setView([d.lat, d.lng], 19);
                showDetail(d);
            });
    });
    renderFenceList();
    renderEvents();
}

async function refresh() {
    try {
        const res = await fetch('/api/locations');
        const devices = await res.json();

        if (!Array.isArray(devices)) {
            statusEl.textContent = 'Server error';
            statusEl.classList.add('error');
            return;
        }

        const activeIds = new Set();
        devices.forEach((d, idx) => {
            activeIds.add(d.device_id);
            updateDevice(d, idx);
        });
        devicesCache = devices;

        Object.keys(markers).forEach(id => {
            if (!activeIds.has(id)) {
                map.removeLayer(markers[id]);
                delete markers[id];
                map.removeLayer(paths[id]);
                delete paths[id];
                delete allPoints[id];
            }
        });

        deviceCountEl.textContent = devices.length;
        lastUpdateEl.textContent = new Date().toLocaleTimeString();
        statusEl.textContent = devices.length ? 'Connected' : 'No devices';
        statusEl.classList.toggle('active', devices.length > 0);
        renderList(devices);
    } catch (e) {
        statusEl.textContent = 'Server offline';
        statusEl.classList.add('error');
        deviceCountEl.textContent = '0';
    }
}

refreshBtn.addEventListener('click', refresh);
centerBtn.addEventListener('click', () => {
    const ids = Object.keys(markers);
    if (!ids.length) return;
    const latlngs = ids.map(id => markers[id].getLatLng());
    map.fitBounds(L.latLngBounds(latlngs).pad(0.2));
});

async function searchLocation(q) {
    if (!q.trim()) return;
    try {
        const url = 'https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&q=' + encodeURIComponent(q);
        const res = await fetch(url, { headers: { 'Accept-Language': 'fil-PH,en' } });
        const data = await res.json();
        if (!data.length) {
            statusEl.textContent = 'Walang nahanap na lugar';
            statusEl.classList.add('error');
            return;
        }
        const loc = data[0];
        map.setView([parseFloat(loc.lat), parseFloat(loc.lon)], 18);
        if (window._infoMarker) map.removeLayer(window._infoMarker);
        window._infoMarker = L.marker([parseFloat(loc.lat), parseFloat(loc.lon)])
            .bindPopup('<b>' + esc(loc.display_name) + '</b><br>Lat: ' + loc.lat + '<br>Lng: ' + loc.lon)
            .addTo(map).openPopup();
        statusEl.textContent = 'Lokasyon nahanap';
        statusEl.classList.remove('error');
        statusEl.classList.add('active');
    } catch (e) {
        statusEl.textContent = 'Search error';
        statusEl.classList.add('error');
    }
}

searchBox.addEventListener('keydown', e => {
    if (e.key === 'Enter') searchLocation(searchBox.value);
});

// ---------------------------------------------------------------------------
// History playback & reports
// ---------------------------------------------------------------------------

const histState = {
    device: null, from: 0, to: 0,
    points: [], trips: [], idx: 0,
    playing: false, timer: null,
    marker: null, trail: null, fullLine: null
};

function fmtDist(m) {
    if (m == null) return '--';
    return m < 1000 ? Math.round(m) + ' m' : (m / 1000).toFixed(2) + ' km';
}

function fmtDur(ms) {
    if (ms == null) return '--';
    const s = Math.floor(ms / 1000);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    if (h) return h + 'h ' + m + 'm';
    if (m) return m + 'm ' + (s % 60) + 's';
    return s + 's';
}

function toLocalInput(ms) {
    const d = new Date(ms);
    d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
    return d.toISOString().slice(0, 16);
}

function openHistory() {
    const sel = document.getElementById('histDevice');
    const prev = histState.device || localStorage.getItem('gt_hist_dev') || '';
    sel.innerHTML = devicesCache.length
        ? devicesCache.map(d => `<option value="${esc(d.device_id)}" ${d.device_id === prev ? 'selected' : ''}>${esc(d.name)}</option>`).join('')
        : '<option value="">Wala pang devices</option>';
    if (!histState.from) {
        document.getElementById('histFrom').value = toLocalInput(Date.now() - 24 * 3600 * 1000);
        document.getElementById('histTo').value = toLocalInput(Date.now());
    }
    document.getElementById('historyModal').style.display = 'flex';
}

function closeHistory() {
    pauseHist();
    if (histState.marker) { map.removeLayer(histState.marker); histState.marker = null; }
    if (histState.trail) { map.removeLayer(histState.trail); histState.trail = null; }
    if (histState.fullLine) { map.removeLayer(histState.fullLine); histState.fullLine = null; }
    document.getElementById('historyModal').style.display = 'none';
}

async function loadHistory() {
    const device = document.getElementById('histDevice').value;
    if (!device) { toast('Wala pang devices.', 'error'); return; }
    const from = new Date(document.getElementById('histFrom').value).getTime();
    const to = new Date(document.getElementById('histTo').value).getTime();
    if (isNaN(from) || isNaN(to)) { toast('Pumili ng petsa/oras.', 'error'); return; }

    histState.device = device;
    histState.from = from;
    histState.to = to;
    localStorage.setItem('gt_hist_dev', device);

    const summaryEl = document.getElementById('histSummary');
    summaryEl.innerHTML = '<span class="chip">Loading...</span>';
    try {
        const res = await fetch(`/api/history?device_id=${encodeURIComponent(device)}&from=${from}&to=${to}`);
        const j = await res.json();
        if (!res.ok) throw new Error(j.error || res.status);

        pauseHist();
        if (histState.marker) map.removeLayer(histState.marker);
        if (histState.trail) map.removeLayer(histState.trail);
        if (histState.fullLine) map.removeLayer(histState.fullLine);
        histState.points = j.points || [];
        histState.trips = j.trips || [];
        histState.idx = 0;

        if (!histState.points.length) {
            summaryEl.innerHTML = '<span class="chip">❌ Walang nahanap na data sa range na ito</span>';
            document.getElementById('histPlayer').style.display = 'none';
            document.getElementById('histTrips').innerHTML = '';
            return;
        }

        const latlngs = histState.points.map(p => [p.lat, p.lng]);
        histState.fullLine = L.polyline(latlngs, { color: '#3498db', weight: 3, opacity: 0.3, dashArray: '4 6' }).addTo(map);
        histState.trail = L.polyline([], { color: '#3498db', weight: 5, opacity: 0.9 }).addTo(map);
        histState.marker = L.marker(latlngs[0], {
            icon: L.divIcon({ html: '<div class="histDot"></div>', className: '' }),
            zIndexOffset: 1000
        }).addTo(map);
        map.fitBounds(L.latLngBounds(latlngs).pad(0.2));

        const s = j.summary;
        summaryEl.innerHTML =
            `<span class="chip">📏 ${fmtDist(s.distance_m)}</span>` +
            `<span class="chip">⏱ ${fmtDur(s.duration_ms)}</span>` +
            `<span class="chip">⚡ max ${s.max_speed_kmh} km/h</span>` +
            `<span class="chip">📈 avg ${s.avg_speed_kmh} km/h</span>` +
            `<span class="chip">📍 ${s.points} pts</span>` +
            `<span class="chip">🚗 ${histState.trips.length} trip(s)</span>`;

        const slider = document.getElementById('histSlider');
        slider.max = histState.points.length - 1;
        slider.value = 0;
        document.getElementById('histPlayer').style.display = 'block';
        renderTrips();
        histRender();
    } catch (e) {
        summaryEl.innerHTML = `<span class="chip">❌ Error: ${esc(String(e.message || e))}</span>`;
    }
}

function histRender() {
    const p = histState.points[histState.idx];
    if (!p) return;
    const ll = [p.lat, p.lng];
    histState.marker.setLatLng(ll);
    histState.trail.setLatLngs(histState.points.slice(0, histState.idx + 1).map(q => [q.lat, q.lng]));
    document.getElementById('histSlider').value = histState.idx;
    const spd = p.speed != null ? (p.speed * 3.6).toFixed(0) + ' km/h' : '--';
    const acc = p.accuracy != null ? '±' + Math.round(p.accuracy) + 'm' : '';
    document.getElementById('histInfo').textContent =
        `${new Date(p.ts).toLocaleString()} · ${spd} ${acc} · ${histState.idx + 1}/${histState.points.length}`;
}

function playHist() {
    if (histState.playing || histState.points.length < 2) return;
    histState.playing = true;
    document.getElementById('histPlay').textContent = '⏸';
    const mult = parseInt(document.getElementById('histSpeed').value) || 1;
    histState.timer = setInterval(() => {
        histState.idx += mult;
        if (histState.idx >= histState.points.length - 1) {
            histState.idx = histState.points.length - 1;
            histRender();
            pauseHist();
            return;
        }
        histRender();
    }, 300);
}

function pauseHist() {
    histState.playing = false;
    if (histState.timer) { clearInterval(histState.timer); histState.timer = null; }
    document.getElementById('histPlay').textContent = '▶';
}

function histSeek(ts) {
    const i = histState.points.findIndex(p => p.ts >= ts);
    histState.idx = i < 0 ? histState.points.length - 1 : i;
    pauseHist();
    histRender();
    const p = histState.points[histState.idx];
    if (p) map.setView([p.lat, p.lng], Math.max(map.getZoom(), 16));
}

function renderTrips() {
    const el = document.getElementById('histTrips');
    if (!histState.trips.length) { el.innerHTML = ''; return; }
    let html = '<table class="tripsTbl"><tr><th>#</th><th>Start</th><th>Duration</th><th>Distance</th><th>Max speed</th></tr>';
    html += histState.trips.map((t, i) =>
        `<tr class="tripRow" data-ts="${t.start_ts}"><td>${i + 1}</td>` +
        `<td>${new Date(t.start_ts).toLocaleString()}</td>` +
        `<td>${fmtDur(t.duration_ms)}</td>` +
        `<td>${fmtDist(t.distance_m)}</td>` +
        `<td>${t.max_speed_kmh} km/h</td></tr>`
    ).join('');
    el.innerHTML = html + '</table>';
}

historyBtn.addEventListener('click', openHistory);
document.getElementById('histClose').addEventListener('click', closeHistory);
document.getElementById('histLoad').addEventListener('click', loadHistory);
document.getElementById('histPlay').addEventListener('click', () => histState.playing ? pauseHist() : playHist());
document.getElementById('histStart').addEventListener('click', () => { pauseHist(); histState.idx = 0; histRender(); });
document.getElementById('histEnd').addEventListener('click', () => { pauseHist(); histState.idx = histState.points.length - 1; histRender(); });
document.getElementById('histSlider').addEventListener('input', e => { pauseHist(); histState.idx = parseInt(e.target.value); histRender(); });
document.getElementById('histSpeed').addEventListener('change', () => { if (histState.playing) { pauseHist(); playHist(); } });
document.getElementById('histTrips').addEventListener('click', e => {
    const row = e.target.closest('.tripRow');
    if (row) histSeek(parseInt(row.dataset.ts));
});
document.getElementById('histExportGpx').addEventListener('click', () => exportHistory('gpx'));
document.getElementById('histExportCsv').addEventListener('click', () => exportHistory('csv'));

function exportHistory(fmt) {
    if (!histState.device || !histState.points.length) { toast('I-load muna ang history.', 'error'); return; }
    const url = `/api/export?device_id=${encodeURIComponent(histState.device)}&from=${histState.from}&to=${histState.to}&format=${fmt}`;
    window.open(url, '_blank');
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

initMap();
loadFences();
loadSettings();
refresh();
fetchEvents();
setInterval(() => { refresh(); fetchEvents(); }, 5000);
