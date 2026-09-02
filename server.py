import json
import math
import os
import re
import sqlite3
import threading
import time
import uuid
from datetime import datetime, timezone

from flask import Flask, Response, jsonify, request, send_from_directory

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
DB_FILE = os.path.join(DATA_DIR, "tracker.db")

MAX_POINTS_PER_DEVICE = 2000        # live JSON trail cap (SQLite keeps full history)
MAX_EVENTS = 500
SPEEDING_DEDUPE_MS = 5 * 60 * 1000          # one speeding alert per device per 5 min
OFFLINE_CHECK_INTERVAL = 30.0               # seconds between offline sweeps
OFFLINE_MAX_AGE_MS = 24 * 60 * 60 * 1000    # ignore devices not seen for over a day
TRIP_GAP_MS = 5 * 60 * 1000                 # gap between points that splits trips
MAX_SEGMENT_SPEED_MS = 83.0                 # ~300 km/h; skip faster (teleport/noise) segments
HISTORY_LIMIT = 20000                       # max points returned per history query

FENCE_COLORS = ["#e74c3c", "#9b59b6", "#f39c12", "#16a085", "#2980b9", "#d35400"]

# All data files are small JSON; guard read-modify-write cycles with one lock.
# The lock also guards the SQLite connection (single-connection design).
data_lock = threading.Lock()

DEFAULT_SETTINGS = {"speed_limit_kmh": 0, "offline_minutes": 5, "history_days": 30}


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
# SQLite history archive
# ---------------------------------------------------------------------------

_db = None


def get_db():
    global _db
    if _db is None:
        _db = sqlite3.connect(DB_FILE, check_same_thread=False)
        _db.row_factory = sqlite3.Row
        _db.execute("PRAGMA journal_mode=WAL")
        _db.execute(
            """CREATE TABLE IF NOT EXISTS points (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                device_id TEXT NOT NULL,
                ts INTEGER NOT NULL,
                lat REAL NOT NULL,
                lng REAL NOT NULL,
                accuracy REAL,
                speed REAL
            )"""
        )
        _db.execute("CREATE INDEX IF NOT EXISTS idx_points_device_ts ON points(device_id, ts)")
        _db.execute("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)")
        _db.commit()
    return _db


def db_insert_point(device_id, p):
    get_db().execute(
        "INSERT INTO points (device_id, ts, lat, lng, accuracy, speed) VALUES (?,?,?,?,?,?)",
        (device_id, p["ts"], p["lat"], p["lng"], p.get("accuracy"), p.get("speed")),
    )
    get_db().commit()


def db_latest_point(device_id):
    row = get_db().execute(
        "SELECT ts, lat, lng, speed FROM points WHERE device_id=? ORDER BY ts DESC, id DESC LIMIT 1",
        (device_id,),
    ).fetchone()
    return dict(row) if row else None


def db_trail(device_id, n=100):
    rows = get_db().execute(
        "SELECT ts, lat, lng, accuracy, speed FROM points WHERE device_id=? ORDER BY ts DESC LIMIT ?",
        (device_id, n),
    ).fetchall()
    return [dict(r) for r in reversed(rows)]


def db_points_range(device_id, from_ts, to_ts, limit=HISTORY_LIMIT):
    rows = get_db().execute(
        "SELECT ts, lat, lng, accuracy, speed FROM points "
        "WHERE device_id=? AND ts>=? AND ts<=? ORDER BY ts ASC LIMIT ?",
        (device_id, from_ts, to_ts, limit),
    ).fetchall()
    return [dict(r) for r in rows]


def cleanup_old_points(history_days):
    cutoff = int(time.time() * 1000) - int(history_days) * 86400000
    cur = get_db().execute("DELETE FROM points WHERE ts < ?", (cutoff,))
    get_db().commit()
    return cur.rowcount


def backfill_db_from_json():
    """One-time import of existing JSON history into the SQLite archive.

    Uses a claim row in `meta` so multi-worker servers don't double-import.
    Call under data_lock.
    """
    db = get_db()
    claimed = db.execute(
        "INSERT OR IGNORE INTO meta (key, value) VALUES ('backfill_done', '1')"
    ).rowcount
    db.commit()
    if not claimed:
        return
    data = load_data()
    for device_id, device in data.items():
        pts = device.get("points") or []
        if not pts:
            continue
        db.executemany(
            "INSERT INTO points (device_id, ts, lat, lng, accuracy, speed) VALUES (?,?,?,?,?,?)",
            [(device_id, p["ts"], p["lat"], p["lng"], p.get("accuracy"), p.get("speed")) for p in pts],
        )
    db.commit()


# ---------------------------------------------------------------------------
# Geo helpers + trip/summary analytics
# ---------------------------------------------------------------------------

def haversine_m(lat1, lng1, lat2, lng2):
    r = 6371000.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = math.radians(lat2 - lat1)
    dl = math.radians(lng2 - lng1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


def summarize_points(points):
    dist = 0.0
    max_kmh = 0.0
    speed_sum, speed_n = 0.0, 0
    for i, p in enumerate(points):
        s = p.get("speed")
        if s:
            kmh = s * 3.6
            max_kmh = max(max_kmh, kmh)
            speed_sum += kmh
            speed_n += 1
        if i > 0:
            d = haversine_m(points[i - 1]["lat"], points[i - 1]["lng"], p["lat"], p["lng"])
            dt = p["ts"] - points[i - 1]["ts"]
            if dt > 0 and d / dt <= MAX_SEGMENT_SPEED_MS:
                dist += d
    duration = (points[-1]["ts"] - points[0]["ts"]) if len(points) > 1 else 0
    return {
        "distance_m": round(dist, 1),
        "duration_ms": duration,
        "max_speed_kmh": round(max_kmh, 1),
        "avg_speed_kmh": round(speed_sum / speed_n, 1) if speed_n else 0.0,
        "points": len(points),
    }


def detect_trips(points):
    """Split a point list into trips separated by gaps > TRIP_GAP_MS."""
    groups, cur = [], []
    for p in points:
        if cur and p["ts"] - cur[-1]["ts"] > TRIP_GAP_MS:
            groups.append(cur)
            cur = []
        cur.append(p)
    if cur:
        groups.append(cur)
    return [
        {"start_ts": t[0]["ts"], "end_ts": t[-1]["ts"], **summarize_points(t)}
        for t in groups
    ]


def _as_float(v):
    try:
        f = float(v)
        return f if math.isfinite(f) else None
    except (TypeError, ValueError):
        return None


def _iso_utc(ms):
    return datetime.fromtimestamp(ms / 1000, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _safe_filename(s):
    return re.sub(r"[^A-Za-z0-9_-]", "_", s)[:60] or "device"


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
        db_insert_point(device_id, point)  # full-resolution archive
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
# History, trips & export
# ---------------------------------------------------------------------------

def _parse_range_args():
    """Parse device_id/from/to query args. Returns (device_id, from, to, err)."""
    device_id = str(request.args.get("device_id", "")).strip()
    if not device_id:
        return None, None, None, ("device_id is required", 400)
    now = int(time.time() * 1000)

    def ts_arg(name, default):
        v = request.args.get(name)
        if v is None or not str(v).strip():
            return default
        try:
            return int(float(v))
        except (TypeError, ValueError):
            return None

    from_ts = ts_arg("from", now - 24 * 3600 * 1000)
    to_ts = ts_arg("to", now)
    if from_ts is None or to_ts is None:
        return None, None, None, ("from/to must be millisecond timestamps", 400)
    if to_ts < from_ts:
        from_ts, to_ts = to_ts, from_ts
    return device_id, from_ts, to_ts, None


@app.route("/api/history")
def get_history():
    device_id, from_ts, to_ts, err = _parse_range_args()
    if err:
        return jsonify({"error": err[0]}), err[1]

    with data_lock:
        points = db_points_range(device_id, from_ts, to_ts)

    resp = {
        "device_id": device_id,
        "from": from_ts,
        "to": to_ts,
        "count": len(points),
        "points": points,
        "summary": summarize_points(points) if points else None,
        "trips": detect_trips(points) if points else [],
    }
    return jsonify(resp)


@app.route("/api/export")
def export_history():
    device_id, from_ts, to_ts, err = _parse_range_args()
    if err:
        return jsonify({"error": err[0]}), err[1]
    fmt = request.args.get("format", "gpx").lower()
    if fmt not in ("gpx", "csv"):
        return jsonify({"error": "format must be gpx or csv"}), 400

    with data_lock:
        points = db_points_range(device_id, from_ts, to_ts)
    if not points:
        return jsonify({"error": "no points in range"}), 404

    base = f"{_safe_filename(device_id)}_{from_ts}-{to_ts}"

    if fmt == "csv":
        lines = ["timestamp,lat,lng,accuracy_m,speed_mps,speed_kmh"]
        for p in points:
            spd = p.get("speed")
            lines.append(",".join([
                _iso_utc(p["ts"]),
                f"{p['lat']:.6f}",
                f"{p['lng']:.6f}",
                "" if p.get("accuracy") is None else f"{p['accuracy']:.1f}",
                "" if spd is None else f"{spd:.2f}",
                "" if spd is None else f"{spd * 3.6:.2f}",
            ]))
        body = "\n".join(lines) + "\n"
        mime = "text/csv"
    else:
        trkpts = "".join(
            f'<trkpt lat="{p["lat"]:.7f}" lon="{p["lng"]:.7f}">'
            f"<time>{_iso_utc(p['ts'])}</time></trkpt>"
            for p in points
        )
        body = (
            '<?xml version="1.0" encoding="UTF-8"?>'
            '<gpx version="1.1" creator="GPS Tracker" '
            'xmlns="http://www.topografix.com/GPX/1/1">'
            f"<trk><name>{device_id}</name><trkseg>{trkpts}</trkseg></trk></gpx>"
        )
        mime = "application/gpx+xml"

    return Response(
        body,
        mimetype=mime,
        headers={"Content-Disposition": f"attachment; filename={base}.{fmt}"},
    )


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
        days = _as_float(body.get("history_days"))
        if days is not None:
            settings["history_days"] = int(max(1, min(365, days)))
        save_settings(settings)
        return jsonify(settings)


# ---------------------------------------------------------------------------
# Background monitors
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


def _retention_loop():
    while True:
        time.sleep(6 * 3600)
        try:
            with data_lock:
                cleanup_old_points(load_settings().get("history_days", 30))
        except Exception:
            pass


# ---------------------------------------------------------------------------
# Startup: migrate old JSON history into the archive, prune, start monitors
# ---------------------------------------------------------------------------

try:
    with data_lock:
        backfill_db_from_json()
        cleanup_old_points(load_settings().get("history_days", 30))
except Exception:
    pass

threading.Thread(target=_offline_monitor_loop, daemon=True).start()
threading.Thread(target=_retention_loop, daemon=True).start()


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 8080))
    print(f"GPS Tracker server running at http://localhost:{port}")
    print("Device page:  http://localhost:{}/device.html".format(port))
    print("Dashboard:    http://localhost:{}/".format(port))
    app.run(host="0.0.0.0", port=port, threaded=True, debug=False)
