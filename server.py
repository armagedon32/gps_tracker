import json
import os
import time
from flask import Flask, request, jsonify, send_from_directory

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
app = Flask(__name__)

DATA_DIR = os.environ.get("DATA_DIR", os.path.join(BASE_DIR, "data"))
DATA_FILE = os.path.join(DATA_DIR, "locations.json")
os.makedirs(DATA_DIR, exist_ok=True)

MAX_POINTS_PER_DEVICE = 2000


def load_data():
    if os.path.exists(DATA_FILE):
        try:
            with open(DATA_FILE, "r", encoding="utf-8") as f:
                return json.load(f)
        except (json.JSONDecodeError, OSError):
            pass
    return {}


def save_data(data):
    with open(DATA_FILE, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2)


@app.route("/")
def index():
    return send_from_directory(BASE_DIR, "dashboard.html")


@app.route("/<path:filename>")
def static_files(filename):
    return send_from_directory(BASE_DIR, filename)


@app.route("/api/location", methods=["POST"])
def post_location():
    body = request.get_json(silent=True)
    if not body:
        return jsonify({"error": "Invalid JSON"}), 400

    device_id = str(body.get("device_id", "")).strip()
    lat = body.get("lat")
    lng = body.get("lng")

    if not device_id:
        return jsonify({"error": "device_id is required"}), 400
    if lat is None or lng is None:
        return jsonify({"error": "lat and lng are required"}), 400

    data = load_data()
    if device_id not in data:
        data[device_id] = {
            "name": str(body.get("name", device_id)).strip() or device_id,
            "points": [],
        }

    device = data[device_id]
    if "name" in body and str(body.get("name", "")).strip():
        device["name"] = str(body["name"]).strip()

    point = {
        "lat": lat,
        "lng": lng,
        "accuracy": body.get("accuracy"),
        "speed": body.get("speed"),
        "ts": int(time.time() * 1000),
    }
    device["points"].append(point)
    if len(device["points"]) > MAX_POINTS_PER_DEVICE:
        device["points"] = device["points"][-MAX_POINTS_PER_DEVICE:]
    device["last_seen"] = point["ts"]

    save_data(data)
    return jsonify({"ok": True})


@app.route("/api/locations")
def get_locations():
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


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 8080))
    print(f"GPS Tracker server running at http://localhost:{port}")
    print("Device page:  http://localhost:{}/device.html".format(port))
    print("Dashboard:    http://localhost:{}/".format(port))
    app.run(host="0.0.0.0", port=port, threaded=True, debug=False)