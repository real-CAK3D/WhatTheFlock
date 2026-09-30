"""Shared hazard / police reports for Flock You Mobile (Waze-style).

Tiny stdlib-only HTTP server; phones reach it through Tailscale
(`tailscale serve --set-path /reports http://127.0.0.1:8090`), so only
devices on your tailnet can read or post.

  GET  /?bbox=s,w,n,e          active reports in a box
  POST /                       {"type": "...", "lat": .., "lon": .., "dev": "...", "note": "..."}
  POST /<id>/vote              {"up": true|false, "dev": "..."}   still there / gone

Reports expire by type; two "gone" votes remove one early. Stored in
reports.json next to this file.
"""
import json
import os
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

HERE = os.path.dirname(os.path.abspath(__file__))
DB = os.path.join(HERE, "reports.json")
PORT = int(os.environ.get("REPORTS_PORT", "8090"))

# Lifetime (seconds) per report type; a "still there" vote extends it.
TTL = {
    "police": 3600, "accident": 2 * 3600, "hazard": 2 * 3600, "object": 2 * 3600,
    "pothole": 14 * 86400, "construction": 7 * 86400, "closure": 12 * 3600,
    "camera": 60 * 86400, "flock": 180 * 86400, "weather": 3 * 3600,
}
MAX_REPORTS = 5000
lock = threading.Lock()


def load():
    try:
        with open(DB, "r", encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return []


def save(reports):
    tmp = DB + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(reports, f)
    os.replace(tmp, DB)


def active(reports, now=None):
    now = now or time.time()
    return [r for r in reports if r["expires"] > now and r.get("down", 0) < 2]


class Handler(BaseHTTPRequestHandler):
    server_version = "FlockYouReports/1.0"

    def _send(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _body(self):
        n = int(self.headers.get("Content-Length") or 0)
        if n <= 0 or n > 4096:
            return None
        try:
            return json.loads(self.rfile.read(n))
        except ValueError:
            return None

    def log_message(self, fmt, *args):  # quieter log
        pass

    def do_GET(self):
        q = parse_qs(urlparse(self.path).query)
        with lock:
            reps = active(load())
        if "bbox" in q:
            try:
                s, w, n, e = (float(x) for x in q["bbox"][0].split(","))
                reps = [r for r in reps if s <= r["lat"] <= n and w <= r["lon"] <= e]
            except ValueError:
                return self._send(400, {"error": "bad bbox"})
        self._send(200, {"now": time.time(), "reports": reps})

    def do_POST(self):
        path = urlparse(self.path).path.strip("/")
        data = self._body()
        if data is None:
            return self._send(400, {"error": "bad json"})
        now = time.time()
        with lock:
            reports = [r for r in load() if r["expires"] > now - 86400]
            if not path:
                t = data.get("type")
                try:
                    lat, lon = float(data["lat"]), float(data["lon"])
                except (KeyError, TypeError, ValueError):
                    return self._send(400, {"error": "lat/lon required"})
                if t not in TTL or not (-90 <= lat <= 90 and -180 <= lon <= 180):
                    return self._send(400, {"error": "bad type or position"})
                # Merge with a matching report of the same type within ~150 m.
                for r in active(reports, now):
                    if r["type"] == t and abs(r["lat"] - lat) < 0.0014 and abs(r["lon"] - lon) < 0.0019:
                        r["up"] = r.get("up", 0) + 1
                        r["expires"] = max(r["expires"], now + TTL[t])
                        save(reports)
                        return self._send(200, {"report": r, "merged": True})
                r = {"id": uuid.uuid4().hex[:12], "type": t, "lat": round(lat, 6), "lon": round(lon, 6),
                     "ts": now, "expires": now + TTL[t], "up": 0, "down": 0,
                     "dev": str(data.get("dev", ""))[:40], "note": str(data.get("note", ""))[:140]}
                reports.append(r)
                save(reports[-MAX_REPORTS:])
                return self._send(201, {"report": r})
            parts = path.split("/")
            if len(parts) == 2 and parts[1] == "vote":
                for r in reports:
                    if r["id"] == parts[0]:
                        if data.get("up"):
                            r["up"] = r.get("up", 0) + 1
                            r["expires"] = max(r["expires"], now + TTL[r["type"]] / 2)
                        else:
                            r["down"] = r.get("down", 0) + 1
                        save(reports)
                        return self._send(200, {"report": r})
                return self._send(404, {"error": "no such report"})
        self._send(404, {"error": "not found"})


if __name__ == "__main__":
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
