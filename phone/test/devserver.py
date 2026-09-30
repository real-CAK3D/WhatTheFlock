"""Local test server: serves G:\\flock-you (so the app is at /phone/) and
forwards /reports/* to the reports server on 127.0.0.1:8090, like Tailscale.

    python phone/test/devserver.py [port]
"""
import http.server
import os
import sys
import urllib.request

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
REPORTS = "http://127.0.0.1:8090"


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **k):
        super().__init__(*a, directory=ROOT, **k)

    def _proxy(self):
        path = self.path[len("/reports"):] or "/"
        body = self.rfile.read(int(self.headers.get("Content-Length") or 0)) if self.command == "POST" else None
        req = urllib.request.Request(REPORTS + path, data=body, method=self.command,
                                     headers={"Content-Type": self.headers.get("Content-Type", "application/json")})
        try:
            with urllib.request.urlopen(req, timeout=10) as r:
                data, code = r.read(), r.status
        except urllib.error.HTTPError as e:
            data, code = e.read(), e.code
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path.startswith("/reports"):
            return self._proxy()
        return super().do_GET()

    def do_POST(self):
        if self.path.startswith("/reports"):
            return self._proxy()
        self.send_error(405)

    def log_message(self, *a):
        pass


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8089
    http.server.ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()
