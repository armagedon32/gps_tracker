const statusEl = document.getElementById('status');
const deviceCountEl = document.getElementById('deviceCount');
const lastUpdateEl = document.getElementById('lastUpdate');
const refreshBtn = document.getElementById('refreshBtn');
const centerBtn = document.getElementById('centerBtn');
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
    deviceListEl.innerHTML = '<h3>Devices</h3>';
    devices.forEach((d, idx) => {
        const c = COLORS[idx % COLORS.length];
        const acc = accTxt(d.accuracy);
        const dd = document.createElement('div');
        dd.className = 'devitem';
        dd.innerHTML = `<span class="dot" style="background:${c}"></span>
            <button class="focusBtn" data-id="${esc(d.device_id)}">${esc(d.name)}</button>
            <span class="accbadge-${acc.type}">±${acc.txt}</span>
            <span>${ageText(d.age)}</span>`;
        dd.querySelector('.focusBtn').addEventListener('click', () => {
            map.setView([d.lat, d.lng], 19);
            showDetail(d);
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

initMap();

map.on('click', e => {
    reverseGeocode(e.latlng.lat, e.latlng.lng).then(addr => {
        statusEl.textContent = addr;
        statusEl.classList.remove('error');
        statusEl.classList.add('active');
    });
});
refresh();
setInterval(refresh, 5000);