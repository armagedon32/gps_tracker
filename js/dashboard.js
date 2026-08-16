const statusEl = document.getElementById('status');
const deviceCountEl = document.getElementById('deviceCount');
const lastUpdateEl = document.getElementById('lastUpdate');
const refreshBtn = document.getElementById('refreshBtn');
const centerBtn = document.getElementById('centerBtn');
const deviceListEl = document.getElementById('deviceList');

const COLORS = ['#3498db', '#e74c3c', '#2ecc71', '#f39c12', '#9b59b6', '#e67e22', '#1abc9c', '#c0392b'];

let map = null;
const markers = {};      // device_id -> marker
const paths = {};        // device_id -> polyline
const allPoints = {};    // device_id -> [[lat,lng],...]

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

function updateDevice(d, idx) {
    const c = colorFor(d.device_id, idx);

    if (!markers[d.device_id]) {
        markers[d.device_id] = L.marker([d.lat, d.lng], {
            title: d.name,
            icon: L.divIcon({
                html: `<div style="width:14px;height:14px;border-radius:50%;background:${c};border:3px solid #fff;box-shadow:0 0 4px rgba(0,0,0,.4);"></div>`,
                className: ''
            })
        }).addTo(map);
        markers[d.device_id].bindPopup(`<b>${esc(d.name)}</b><br>Last update: ${ageText(d.age)}`);
    } else {
        markers[d.device_id].setLatLng([d.lat, d.lng]);
        markers[d.device_id].setPopupContent(`<b>${esc(d.name)}</b><br>Last update: ${ageText(d.age)}`);
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
    deviceListEl.innerHTML = '<h3>Devices</h3>';
    devices.forEach((d, idx) => {
        const c = COLORS[idx % COLORS.length];
        const dd = document.createElement('div');
        dd.className = 'devitem';
        dd.innerHTML = `<span class="dot" style="background:${c}"></span>
            <button class="focusBtn" data-id="${esc(d.device_id)}">${esc(d.name)}</button>
            <span>${ageText(d.age)}</span>`;
        dd.querySelector('.focusBtn').addEventListener('click', () => {
            map.setView([d.lat, d.lng], 19);
        });
        deviceListEl.appendChild(dd);
    });
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

        // Remove stale markers/paths
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

initMap();
refresh();
setInterval(refresh, 5000);