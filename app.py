"""Local read-only care-team dashboard and JSON API."""
import argparse
import json
from functools import partial
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlsplit

from detection import ROOT, build_days, risk


class Dashboard:
    def __init__(self, data_dir, cutoff):
        self.days = build_days(data_dir)
        self.dates = sorted(self.days)
        self.cutoff = cutoff

    def for_date(self, stamp):
        index = self.dates.index(stamp)
        patients = []
        for pid, day in self.days[stamp].items():
            item = risk(day, self.cutoff)
            item["history"] = [
                {"date": d, "values": self.days[d][pid]["values"]}
                for d in self.dates[max(0, index - 13):index + 1] if pid in self.days[d]
            ]
            patients.append(item)
        patients.sort(key=lambda p: (-(p["score"] if p["score"] is not None else -1), p["patient_id"]))
        return {"date": stamp, "dates": self.dates, "patients": patients}


ASSETS = {
    "/": ("index.html", "text/html"),
    **{f"/{name}": (name, "text/javascript")
       for name in ("app.js", "models.js", "triage.js", "vital-chart.js", "intake.js",
                    "technical.js", "predictions.js")},
    **{f"/{name}": (name, "text/css")
       for name in ("styles.css", "vital-chart.css", "intake.css", "technical.css")},
    **{f"/data/{name}": (f"data/{name}", "application/json")
       for name in ("cohort.json", "models.json", "evaluation.json")},
}


class Handler(BaseHTTPRequestHandler):
    def __init__(self, *args, dashboard, **kwargs):
        self.dashboard = dashboard
        super().__init__(*args, **kwargs)

    def send_body(self, body, mime, status=HTTPStatus.OK):
        self.send_response(status)
        self.send_header("Content-Type", mime + "; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        url = urlsplit(self.path)
        if url.path in ASSETS:
            name, mime = ASSETS[url.path]
            self.send_body((ROOT / "dist" / name).read_bytes(), mime)
        elif url.path == "/api/dashboard":
            query = parse_qs(url.query, keep_blank_values=True)
            dates = query.get("date", [self.dashboard.dates[-1]])
            if len(dates) != 1 or dates[0] not in self.dashboard.days:
                self.send_body(b'{"error":"Choose an available observation date."}', "application/json", 400)
                return
            payload = self.dashboard.for_date(dates[0])
            self.send_body(json.dumps(payload, ensure_ascii=False).encode(), "application/json")
        else:
            self.send_error(404)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=8765)
    args = parser.parse_args()
    try:
        cutoff = json.loads((ROOT / "evaluation.json").read_text(encoding="utf-8"))["cutoff"]
        dashboard = Dashboard(ROOT / "data", cutoff)
        server = ThreadingHTTPServer(("127.0.0.1", args.port), partial(Handler, dashboard=dashboard))
    except (OSError, ValueError, KeyError) as error:
        parser.exit(1, f"Could not start dashboard: {error}\n")
    print(f"Care review dashboard at http://127.0.0.1:{args.port}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
