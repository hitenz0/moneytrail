"""Local web app. Run with: python app.py"""

import argparse
import csv
import hashlib
import io
import json
import sqlite3
from contextlib import contextmanager
from decimal import Decimal
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from main import (FIELDS, FOLLOWUP_FIELDS, parse_transactions, refund_watchlist, spending_by_category,
                  suggest_category, suggest_refund_links, summarize)


ROOT = Path(__file__).resolve().parent
MAX_UPLOAD = 2 * 1024 * 1024


class ConflictError(ValueError):
    pass


def to_csv(rows, fields=None):
    output = io.StringIO(newline="")
    writer = csv.DictWriter(output, fieldnames=FIELDS + FOLLOWUP_FIELDS if fields is None else fields,
                            extrasaction="ignore")
    writer.writeheader()
    writer.writerows(rows)
    return output.getvalue()


class Store:
    def __init__(self, path):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self.connect() as db:
            db.execute("""CREATE TABLE IF NOT EXISTS datasets (
                id INTEGER PRIMARY KEY, name TEXT NOT NULL, fingerprint TEXT NOT NULL UNIQUE,
                version INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            )""")
            db.execute("""CREATE TABLE IF NOT EXISTS transactions (
                dataset_id INTEGER NOT NULL REFERENCES datasets(id), id TEXT NOT NULL,
                date TEXT NOT NULL, description TEXT NOT NULL, amount TEXT NOT NULL,
                account TEXT NOT NULL, kind TEXT NOT NULL, category TEXT NOT NULL,
                refund_expected TEXT NOT NULL, refund_for TEXT NOT NULL,
                PRIMARY KEY (dataset_id, id)
            )""")
            columns = {row["name"] for row in db.execute("PRAGMA table_info(transactions)")}
            for field in FOLLOWUP_FIELDS:
                if field not in columns:
                    db.execute(f"ALTER TABLE transactions ADD COLUMN {field} TEXT NOT NULL DEFAULT ''")

    @contextmanager
    def connect(self):
        db = sqlite3.connect(self.path, timeout=10)
        db.row_factory = sqlite3.Row
        db.execute("PRAGMA foreign_keys = ON")
        try:
            with db:
                yield db
        finally:
            db.close()

    def datasets(self, db):
        return [dict(row) for row in db.execute(
            "SELECT id, name, version, created_at FROM datasets ORDER BY id DESC")]

    def rows(self, db, dataset_id):
        rows = [dict(row) for row in db.execute(
            "SELECT * FROM transactions WHERE dataset_id = ? ORDER BY date, rowid", (dataset_id,))]
        for row in rows:
            row.pop("dataset_id")
            row["amount"] = Decimal(row["amount"])
            row["refund_expected"] = Decimal(row["refund_expected"])
        return rows

    def import_csv(self, name, text):
        if not isinstance(name, str) or not name.strip() or len(name) > 200:
            raise ValueError("Give this import a name of 1 to 200 characters")
        if not isinstance(text, str) or len(text.encode("utf-8")) > MAX_UPLOAD:
            raise ValueError("Choose a UTF-8 CSV smaller than 2 MB")
        rows = parse_transactions(text)
        if not rows or len(rows) > 10000:
            raise ValueError("Import between 1 and 10,000 transactions")
        # Keep fingerprints compatible with imports created before follow-up fields existed.
        fingerprint_fields = FIELDS + FOLLOWUP_FIELDS if any(
            row[field] for row in rows for field in FOLLOWUP_FIELDS) else FIELDS
        fingerprint = hashlib.sha256(to_csv(rows, fingerprint_fields).encode("utf-8")).hexdigest()
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            existing = db.execute("SELECT id FROM datasets WHERE fingerprint = ?", (fingerprint,)).fetchone()
            if existing:
                return existing["id"], True
            dataset_id = db.execute("INSERT INTO datasets (name, fingerprint) VALUES (?, ?)",
                                    (name.strip(), fingerprint)).lastrowid
            fields = FIELDS + FOLLOWUP_FIELDS
            db.executemany(
                f"INSERT INTO transactions (dataset_id, {', '.join(fields)}) VALUES ({', '.join('?' for _ in range(len(fields) + 1))})",
                [(dataset_id, *(str(row[field]) for field in fields)) for row in rows])
        return dataset_id, False

    def state(self, dataset_id=None):
        with self.connect() as db:
            db.execute("BEGIN")
            datasets = self.datasets(db)
            if not datasets:
                return {"datasets": [], "report": None}
            dataset_id = datasets[0]["id"] if dataset_id is None else dataset_id
            dataset = next((item for item in datasets if item["id"] == dataset_id), None)
            if dataset is None:
                raise ValueError("That import no longer exists")
            rows = self.rows(db, dataset_id)
        gross, refunds, net = summarize(rows)
        watchlist = refund_watchlist(rows)
        return {"datasets": datasets, "report": {
            "dataset": dataset, "transactions": rows,
            "summary": {"purchases": gross, "refunds": refunds, "net": net,
                        "still_due": sum((item["remaining"] for item in watchlist), Decimal(0))},
            "categories": spending_by_category(rows), "watchlist": watchlist,
            "refund_suggestions": suggest_refund_links(rows),
            "category_suggestions": {row["id"]: suggest_category(row["description"])
                                     for row in rows if row["kind"] == "purchase" and not row["category"]}
        }}

    def update(self, data):
        dataset_id = data.get("dataset_id")
        transaction_id = data.get("id")
        version = data.get("version")
        changes = data.get("changes")
        if type(dataset_id) is not int or type(version) is not int or not isinstance(transaction_id, str):
            raise ValueError("Choose a transaction from the current import")
        if not isinstance(changes, dict) or not changes or not set(changes) <= {"category", "refund_expected", "refund_for", *FOLLOWUP_FIELDS}:
            raise ValueError("Only category, refund details, and refund link can be edited")
        if any(not isinstance(value, str) or len(value) > 200 for value in changes.values()):
            raise ValueError("Edits must be text of at most 200 characters")
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            dataset = db.execute("SELECT version FROM datasets WHERE id = ?", (dataset_id,)).fetchone()
            if dataset is None:
                raise ValueError("That import no longer exists")
            if dataset["version"] != version:
                raise ConflictError("This import changed in another tab. Reload it before saving again.")
            rows = self.rows(db, dataset_id)
            row = next((row for row in rows if row["id"] == transaction_id), None)
            if row is None:
                raise ValueError("Transaction not found")
            allowed = {"category", "refund_expected", *FOLLOWUP_FIELDS} if row["kind"] == "purchase" else {"refund_for"} if row["kind"] == "refund" else set()
            if not set(changes) <= allowed:
                raise ValueError("That field does not apply to this transaction")
            row.update(changes)
            checked = parse_transactions(to_csv(rows))
            row = next(row for row in checked if row["id"] == transaction_id)
            db.execute("UPDATE transactions SET category = ?, refund_expected = ?, refund_for = ?, refund_due = ?, refund_note = ? WHERE dataset_id = ? AND id = ?",
                       (row["category"], str(row["refund_expected"]), row["refund_for"], row["refund_due"], row["refund_note"], dataset_id, transaction_id))
            db.execute("UPDATE datasets SET version = version + 1 WHERE id = ?", (dataset_id,))


class Handler(BaseHTTPRequestHandler):
    def send(self, status, content, content_type="application/json; charset=utf-8", download=False):
        if content_type.startswith("application/json"):
            content = json.dumps(content, default=str).encode("utf-8")
        elif isinstance(content, str):
            content = content.encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(content)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'")
        if download:
            self.send_header("Content-Disposition", 'attachment; filename="moneytrail-reviewed.csv"')
        self.end_headers()
        self.wfile.write(content)

    def local_request(self):
        port = self.server.server_port
        hosts = {f"127.0.0.1:{port}", f"localhost:{port}"}
        return self.headers.get("Host") in hosts and self.headers.get("Origin") in (
            None, f"http://127.0.0.1:{port}", f"http://localhost:{port}")

    def do_GET(self):
        if not self.local_request():
            self.send(403, {"error": "Open MoneyTrail using its local address"})
            return
        url = urlparse(self.path)
        static = {"/": ("index.html", "text/html"), "/index.html": ("index.html", "text/html"),
                  "/app.js": ("app.js", "text/javascript"), "/theme.js": ("theme.js", "text/javascript"),
                  "/style.css": ("style.css", "text/css")}
        if url.path in static:
            name, content_type = static[url.path]
            self.send(200, (ROOT / name).read_bytes(), content_type + "; charset=utf-8")
            return
        try:
            selected = parse_qs(url.query).get("dataset", [None])[0]
            selected = int(selected) if selected is not None else None
            if url.path == "/api/state":
                self.send(200, self.server.store.state(selected))
            elif url.path == "/api/export":
                state = self.server.store.state(selected)
                if state["report"] is None:
                    raise ValueError("Import a CSV first")
                self.send(200, to_csv(state["report"]["transactions"]), "text/csv; charset=utf-8", download=True)
            else:
                self.send(404, {"error": "Page not found"})
        except ValueError as error:
            self.send(400, {"error": str(error)})
        except sqlite3.Error:
            self.send(500, {"error": "Could not read saved imports. Please try again."})

    def do_POST(self):
        if not self.local_request():
            self.send(403, {"error": "Open MoneyTrail using its local address"})
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if not 0 < length <= MAX_UPLOAD + 65536:
                self.send(413, {"error": "Choose a CSV smaller than 2 MB"})
                return
            if self.headers.get("Content-Type", "").split(";")[0] != "application/json":
                raise ValueError("Send JSON data")
            data = json.loads(self.rfile.read(length))
            if not isinstance(data, dict):
                raise ValueError("Expected a JSON object")
            duplicate = False
            if self.path == "/api/import":
                selected, duplicate = self.server.store.import_csv(data.get("name"), data.get("csv"))
            elif self.path == "/api/demo":
                selected, duplicate = self.server.store.import_csv("Student demo", (ROOT / "examples" / "demo.csv").read_text(encoding="utf-8"))
            elif self.path == "/api/transaction":
                self.server.store.update(data)
                selected = data["dataset_id"]
            else:
                self.send(404, {"error": "Action not found"})
                return
            state = self.server.store.state(selected)
            state["duplicate"] = duplicate
            self.send(200, state)
        except ConflictError as error:
            self.send(409, {"error": str(error)})
        except (ValueError, csv.Error, UnicodeError) as error:
            self.send(400, {"error": str(error)})
        except sqlite3.Error:
            self.send(500, {"error": "Could not save the change. Please try again."})


def make_server(path, port=8001):
    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    server.store = Store(path)
    return server


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Start the local MoneyTrail web app")
    parser.add_argument("--port", type=int, default=8001)
    parser.add_argument("--db", type=Path, default=ROOT / "data" / "moneytrail.db")
    args = parser.parse_args()
    server = make_server(args.db, args.port)
    print(f"MoneyTrail is running at http://127.0.0.1:{server.server_port}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
