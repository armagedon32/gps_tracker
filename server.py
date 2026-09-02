import json
import math
import os
import threading
import time
import uuid

from flask import Flask, jsonify, request, send_from_directory

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
app = Flask(__name__)

CORS_ORIGIN = os.environ.get("CORS_ORIGIN", "*")


@app.after_request
def add_cors_headers(response):
    response.headers["Access-Control-Allow-Origin"] = CORS_ORIGIN
    response.headers["Access-Control-Allow-Methods"] = "GET, POST, DELETE, OPTIONS"
    response.headers["Access-Control-Allow-Headers"] = "Content-Type"
    return response


DATA_DIR = os.environ.get("DATA_DIR", os.path.join(BASE_DIR, "data"))
os.makedirs(DATA_DIR, exist_ok=True)

DATA_FILE = os.path.join(DATA_DIR, "locations.json")
FENCE_FILE = os.path.join(DATA_DIR, "geofences.json")
EVENT_FILE = os.path.join(DATA_DIR, "events.json")
SETTINGS_FILE = os.path.join(DATA_DIR, "settings.json")

MAX_POINTS_PER_DEVICE = 2000
MAX_EVENTS = 500
SPEEDING_DEDUPE_MS = 5 * 60 * 1000          # one speeding alert per device per 5 min
OFFLINE_CHECK_INTERVAL = 30.0               # seconds between offline sweeps
OFFLINE_MAX_AGE_MS = 24 * 60 * 60 * 1000    # ignore devices not seen for over a day

FENCE_COLORS = ["#e74c3c", "#9b59b6", "#f39c12", "#16a085", "#2980b9", "#d35400"]

# All data files are small JSON; guard read-modify-write cycles with one lock.
data_lock = threading.Lock()

DEFAULT_SETTINGS = {"speed_limit_kmh": 0, "offline_minutes": 5}


# ---------------------------------------------------------------------------
# Storage helpers (atomic writes: temp file + os.replace)
# ---------------------------------------------------------------------------

def _load_json(path, default):
    if os.path.exists(path):
        try:
            with open(path, "r", encoding="utf-8") as f:
                return json.load(f)
        except (json.JSONDecodeError, OSError):
            pass
    return default() if callable(default) else default


def _save_json(path, obj):
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(obj, f, indent=2)
    os.replace(tmp, path)


def load_data():
    return _load_json(DATA_FILE, dict)


def save_data(data):
    _save_json(DATA_FILE, data)


def load_fences():
    return _load_json(FENCE_FILE, list)


def save_fences(fences):
    _save_json(FENCE_FILE, fences)


def load_events():
    return _load_json(EVENT_FILE, list)


def save_events(events):
    _save_json(EVENT_FILE, events)


def load_settings():
    s = dict(DEFAULT_SETTINGS)
    s.update(_load_json(SETTINGS_FILE, dict))
    return s


def save_settings(settings):
    _save_json(SETTINGS_FILE, settings)


def make_event(ev_type, device_id, device_name, message, data=None):
    return {
        "id": uuid.uuid4().hex[:8],
        "ts": int(time.time() * 1000),
        "type": ev_type,
        "device_id": device_id,
        "device_name": device_name or device_id,
        "message": message,
        "data": data or {},
    }


# ---------------------------------------------------------------------------
# Geo helpers
# ---------------------------------------------------------------------------

def haversine_m(lat1, lng1, lat2, lng2):
    r = 6371000.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = math.radians(lat2 - lat1)
    dl = math.radians(lng2 - lng1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


def _as_float(v):
    try:
        f = float(v)
        return f if math.isfinite(f) else None
    except (TypeError, ValueError):
        return None


# ---------------------------------------------------------------------------
# Static pages
# ---------------------------------------------------------------------------

@app.route("/")
def index():
    return send_from_directory(BASE_DIR, "dashboard.html")


@app.route("/<path:filename>")
def static_files(filename):
    return send_from_directory(BASE_DIR, filename)


# ---------------------------------------------------------------------------
# Device locations
# ---------------------------------------------------------------------------

@app.route("/api/location", methods=["POST"])
def post_location():
    body = request.get_json(silent=True)
    if not body:
        return jsonify({"error": "Invalid JSON"}), 400

    device_id = str(body.get("device_id", "")).strip()
    lat = _as_float(body.get("lat"))
    lng = _as_float(body.get("lng"))

    if not device_id:
        return jsonify({"error": "device_id is required"}), 400
    if lat is None or lng is None:
        return jsonify({"error": "lat and lng are required and must be numbers"}), 400
    if not (-90 <= lat <= 90) or not (-180 <= lng <= 180):
        return jsonify({"error": "lat/lng out of range"}), 400

    accuracy = _as_float(body.get("accuracy"))
    speed = _as_float(body.get("speed"))

    with data_lock:
        data = load_data()
        if device_id not in data:
            data[device_id] = {"name": device_id, "points": []}
        device = data[device_id]

        name = str(body.get("name", "")).strip()
        if name:
            device["name"] = name
        dev_name = device.get("name", device_id)

        points = device.get("points", [])
        prev = points[-1] if points else None

        point = {
            "lat": lat,
            "lng": lng,
            "accuracy": accuracy,
            "speed": speed,
            "ts": int(time.time() * 1000),
        }
        points.append(point)
        if len(points) > MAX_POINTS_PER_DEVICE:
            device["points"] = points[-MAX_POINTS_PER_DEVICE:]
        prev_seen = device.get("last_seen")
        device["last_seen"] = point["ts"]

        new_events = evaluate_alerts(device_id, dev_name, prev, point, prev_seen)
        save_data(data)
        if new_events:
            events = load_events()
            events.extend(new_events)
            save_events(events[-MAX_EVENTS:])

    return jsonify({"ok": True, "events": len(new_events)}) if new_events else jsonify({"ok": True})


def evaluate_alerts(device_id, dev_name, prev, point, prev_seen):
    """Geofence enter/exit, speeding and back-online detection. Call under lock."""
    now = point["ts"]
    events = load_events()
    out = []

    # Back online after an offline alert
    if prev_seen is not None:
        was_flagged_offline = any(
            e["type"] == "offline" and e["device_id"] == device_id and e["ts"] > prev_seen
            for e in events
        )
        if was_flagged_offline:
            out.append(make_event("online", device_id, dev_name, f"{dev_name} is back online"))

    # Geofence transitions
    fences = load_fences()
    if prev is not None and fences:
        for f in fences:
            r = float(f.get("radius", 0))
            prev_in = haversine_m(prev["lat"], prev["lng"], f["lat"], f["lng"]) <= r
            now_in = haversine_m(point["lat"], point["lng"], f["lat"], f["lng"]) <= r
            if now_in and not prev_in:
                out.append(make_event(
                    "enter", device_id, dev_name,
                    f"{dev_name} entered '{f['name']}'",
                    {"fence_id": f["id"], "fence": f["name"], "lat": point["lat"], "lng": point["lng"]},
                ))
            elif prev_in and not now_in:
                out.append(make_event(
                    "exit", device_id, dev_name,
                    f"{dev_name} left '{f['name']}'",
                    {"fence_id": f["id"], "fence": f["name"], "lat": point["lat"], "lng": point["lng"]},
                ))

    # Speeding
    settings = load_settings()
    limit = settings.get("speed_limit_kmh", 0)
    if limit and point.get("speed") is not None:
        kmh = round(point["speed"] * 3.6, 1)
        if kmh > limit:
            recent = any(
                e["type"] == "speeding" and e["device_id"] == device_id
                and e["ts"] > now - SPEEDING_DEDUPE_MS
                for e in events
            )
            if not recent:
                out.append(make_event(
                    "speeding", device_id, dev_name,
                    f"{dev_name} is OVER SPEED: {kmh} km/h (limit {limit})",
                    {"kmh": kmh, "limit": limit},
                ))
    return out


@app.route("/api/locations")
def get_locations():
    with data_lock:
        data = load_data()
    result = []
    now = int(time.time() * 1000)
    for device_id, device in data.items():
        points = device.get("points", [])
        if not points:
            continue
        latest = points[-1]
        result.append(
            {
                "device_id": device_id,
                "name": device.get("name", device_id),
                "lat": latest["lat"],
                "lng": latest["lng"],
                "accuracy": latest.get("accuracy"),
                "speed": latest.get("speed"),
                "ts": latest["ts"],
                "age": now - latest["ts"],
                "sees_detail": points if len(points) <= 100 else points[-100:],
            }
        )
    return jsonify(result)


# ---------------------------------------------------------------------------
# SOS
# ---------------------------------------------------------------------------

@app.route("/api/sos", methods=["POST"])
def post_sos():
    body = request.get_json(silent=True)
    if not body:
        return jsonify({"error": "Invalid JSON"}), 400

    device_id = str(body.get("device_id", "")).strip()
    lat = _as_float(body.get("lat"))
    lng = _as_float(body.get("lng"))
    if not device_id:
        return jsonify({"error": "device_id is required"}), 400
    if lat is None or lng is None or not (-90 <= lat <= 90) or not (-180 <= lng <= 180):
        return jsonify({"error": "valid lat and lng are required"}), 400

    name = str(body.get("name", "")).strip() or device_id

    with data_lock:
        ev = make_event(
            "sos", device_id, name,
            f"SOS! {name} sent an emergency alert",
            {"lat": lat, "lng": lng, "accuracy": _as_float(body.get("accuracy"))},
        )
        events = load_events()
        events.append(ev)
        save_events(events[-MAX_EVENTS:])
    return jsonify({"ok": True})


# ---------------------------------------------------------------------------
# Geofences
# ---------------------------------------------------------------------------

@app.route("/api/geofences")
def get_geofences():
    with data_lock:
        return jsonify(load_fences())


@app.route("/api/geofences", methods=["POST"])
def post_geofence():
    body = request.get_json(silent=True)
    if not body:
        return jsonify({"error": "Invalid JSON"}), 400

    name = str(body.get("name", "")).strip()
    lat = _as_float(body.get("lat"))
    lng = _as_float(body.get("lng"))
    radius = _as_float(body.get("radius"))

    if not name:
        return jsonify({"error": "name is required"}), 400
    if lat is None or lng is None or not (-90 <= lat <= 90) or not (-180 <= lng <= 180):
        return jsonify({"error": "valid lat and lng are required"}), 400
    if radius is None or not (10 <= radius <= 100000):
        return jsonify({"error": "radius must be 10-100000 meters"}), 400

    with data_lock:
        fences = load_fences()
        fence = {
            "id": uuid.uuid4().hex[:8],
            "name": name,
            "lat": lat,
            "lng": lng,
            "radius": round(radius, 1),
            "color": FENCE_COLORS[len(fences) % len(FENCE_COLORS)],
        }
        fences.append(fence)
        save_fences(fences)
    return jsonify(fence)


@app.route("/api/geofences/<fence_id>", methods=["DELETE"])
def delete_geofence(fence_id):
    with data_lock:
        fences = load_fences()
        remaining = [f for f in fences if f["id"] != fence_id]
        if len(remaining) == len(fences):
            return jsonify({"error": "not found"}), 404
        save_fences(remaining)
    return jsonify({"ok": True})


# ---------------------------------------------------------------------------
# Events feed
# ---------------------------------------------------------------------------

@app.route("/api/events")
def get_events():
    try:
        since = int(request.args.get("since", -1))
    except ValueError:
        since = -1
    try:
        limit = max(1, min(200, int(request.args.get("limit", 50))))
    except ValueError:
        limit = 50

    with data_lock:
        events = load_events()

    if since >= 0:
        out = [e for e in events if e["ts"] > since][-limit:]
        return jsonify(out)  # ascending (oldest first)

    out = sorted(events, key=lambda e: e["ts"], reverse=True)[:limit]
    return jsonify(out)  # descending (newest first)


# ---------------------------------------------------------------------------
# Settings
# ---------------------------------------------------------------------------

@app.route("/api/settings")
def get_settings():
    with data_lock:
        return jsonify(load_settings())


@app.route("/api/settings", methods=["POST"])
def post_settings():
    body = request.get_json(silent=True)
    if not body:
        return jsonify({"error": "Invalid JSON"}), 400

    with data_lock:
        settings = load_settings()
        limit = _as_float(body.get("speed_limit_kmh"))
        if limit is not None:
            settings["speed_limit_kmh"] = int(max(0, min(300, limit)))
        mins = _as_float(body.get("offline_minutes"))
        if mins is not None:
            settings["offline_minutes"] = int(max(1, min(1440, mins)))
        save_settings(settings)
        return jsonify(settings)


# ---------------------------------------------------------------------------
# Offline monitor (devices that stopped sending)
# ---------------------------------------------------------------------------

def check_offline_devices():
    with data_lock:
        settings = load_settings()
        threshold = max(1, settings.get("offline_minutes", 5)) * 60 * 1000
        now = int(time.time() * 1000)
        data = load_data()
        events = load_events()
        out = []
        for device_id, device in data.items():
            last_seen = device.get("last_seen")
            if not last_seen:
                continue
            age = now - last_seen
            if age <= threshold or age > OFFLINE_MAX_AGE_MS:
                continue
            # already alerted for this outage?
            if any(e["type"] == "offline" and e["device_id"] == device_id and e["ts"] > last_seen for e in events):
                continue
            name = device.get("name", device_id)
            out.append(make_event(
                "offline", device_id, name,
                f"{name} is OFFLINE — no update for {round(age / 60000)} min",
                {"last_seen": last_seen},
            ))
        if out:
            events.extend(out)
            save_events(events[-MAX_EVENTS:])
        return out


def _offline_monitor_loop():
    while True:
        time.sleep(OFFLINE_CHECK_INTERVAL)
        try:
            check_offline_devices()
        except Exception:
            pass


threading.Thread(target=_offline_monitor_loop, daemon=True).start()


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 8080))
    print(f"GPS Tracker server running at http://localhost:{port}")
    print("Device page:  http://localhost:{}/device.html".format(port))
    print("Dashboard:    http://localhost:{}/".format(port))
    app.run(host="0.0.0.0", port=port, threaded=True, debug=False)
