const statusEl = document.getElementById('status');
const startBtn = document.getElementById('startBtn');
const clearBtn = document.getElementById('clearBtn');
const centerBtn = document.getElementById('centerBtn');
const latEl = document.getElementById('lat');
const lngEl = document.getElementById('lng');
const accEl = document.getElementById('accuracy');
const speedEl = document.getElementById('speed');
const distanceEl = document.getElementById('distance');

let isTracking = false;
let watchId = null;
let map = null;
let marker = null;
let path = null;
let pathLatLngs = [];
let lastPosition = null;
let totalDistance = 0;

function initMap() {
    map = L.map('map').setView([14.5995, 120.9842], 12);

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
    }).addTo(map);

    path = L.polyline(pathLatLngs, {
        color: '#3498db',
        weight: 4,
        opacity: 0.8
    }).addTo(map);
}

function haversine(a, b) {
    const R = 6371000;
    const toRad = (deg) => (deg * Math.PI) / 180;
    const dLat = toRad(b.lat - a.lat);
    const dLng = toRad(b.lng - a.lng);
    const s =
        Math.sin(dLat / 2) ** 2 +
        Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(s));
}

function addPoint(latlng) {
    pathLatLngs.push(latlng);
    path.setLatLngs(pathLatLngs);

    if (lastPosition) {
        const d = haversine(lastPosition, latlng);
        if (d > 1) {
            totalDistance += d;
            distanceEl.textContent = Math.round(totalDistance);
        }
    }
    lastPosition = latlng;
}

function onLocation(position) {
    const { latitude, longitude, accuracy, speed } = position.coords;

    latEl.textContent = latitude.toFixed(6);
    lngEl.textContent = longitude.toFixed(6);
    accEl.textContent = accuracy.toFixed(0);
    speedEl.textContent = speed > 0 ? (speed * 3.6).toFixed(1) : '0.0';

    const latlng = { lat: latitude, lng: longitude };

    if (!marker) {
        marker = L.marker(latlng).addTo(map);
        marker.bindPopup('<b>Ito ka!</b>').openPopup();
    } else {
        marker.setLatLng(latlng);
    }

    addPoint(latlng);
}

function onError(err) {
    statusEl.textContent = 'Error getting location';
    statusEl.classList.add('error');
    console.error(err);
    stopTracking();
}

function startTracking() {
    if (!navigator.geolocation) {
        statusEl.textContent = 'Geolocation not supported';
        statusEl.classList.add('error');
        return;
    }

    isTracking = true;
    startBtn.textContent = 'Stop Tracking';
    startBtn.classList.add('active');
    statusEl.textContent = 'Tracking...';
    statusEl.classList.add('active');

    watchId = navigator.geolocation.watchPosition(onLocation, onError, {
        enableHighAccuracy: true,
        maximumAge: 0,
        timeout: 5000
    });
}

function stopTracking() {
    isTracking = false;
    startBtn.textContent = 'Start Tracking';
    startBtn.classList.remove('active');
    statusEl.textContent = 'Stopped';
    statusEl.classList.remove('active', 'error');
    if (watchId !== null) {
        navigator.geolocation.clearWatch(watchId);
        watchId = null;
    }
    if (marker) {
        map.removeLayer(marker);
        marker = null;
    }
}

function clearPath() {
    pathLatLngs = [];
    path.setLatLngs(pathLatLngs);
    lastPosition = null;
    totalDistance = 0;
    distanceEl.textContent = '0';
    latEl.textContent = '--';
    lngEl.textContent = '--';
    accEl.textContent = '--';
    speedEl.textContent = '--';
}

function centerOnMe() {
    if (lastPosition) {
        map.setView([lastPosition.lat, lastPosition.lng], 16);
    }
}

startBtn.addEventListener('click', () => {
    if (isTracking) {
        stopTracking();
    } else {
        startTracking();
    }
});

clearBtn.addEventListener('click', clearPath);
centerBtn.addEventListener('click', centerOnMe);

initMap();