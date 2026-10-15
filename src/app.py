"""Local web app. Run from the project root with: python -m src.app"""

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
from datetime import date

from .bills import BillConflictError, bill_date, bill_report, create_bill_table, save_bill
from .comparison import compare, validate_periods
from .statement_import import convert_statement, inspect_statement

from .main import (FIELDS, FOLLOWUP_FIELDS, parse_transactions, refund_watchlist,
                   spending_by_category, suggest_category, suggest_refund_links, summarize)


ROOT = Path(__file__).resolve().parent.parent
STATIC_DIR = ROOT / "src" / "static"
TEMPLATE_DIR = ROOT / "src" / "templates"
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
            create_bill_table(db)

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
            """SELECT d.id, d.name, d.version, d.created_at,
                      MIN(t.date) AS first_date, MAX(t.date) AS last_date
               FROM datasets d LEFT JOIN transactions t ON t.dataset_id = d.id
               GROUP BY d.id ORDER BY d.id DESC""")]

    def comparison(self, data):
        before, after = validate_periods(data)
        with self.connect() as db:
            db.execute("BEGIN")
            datasets = {item["id"]: item for item in self.datasets(db)}
            if any(period["dataset_id"] not in datasets for period in (before, after)):
                raise ValueError("That import no longer exists")
            before_rows = self.rows(db, before["dataset_id"])
            after_rows = before_rows if before["dataset_id"] == after["dataset_id"] else self.rows(db, after["dataset_id"])
        return compare(before_rows, after_rows, before, after,
                       datasets[before["dataset_id"]], datasets[after["dataset_id"]])

    def bills(self, today):
        with self.connect() as db:
            return bill_report(db, today)

    def update_bill(self, data, today):
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            save_bill(db, data, today)
            return bill_report(db, today)

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
            "refund_suggestions": suggest_refund_links(rows, watchlist),
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
        if not isinstance(changes, dict) or not changes or not set(changes) <= {"kind", "category", "refund_expected", "refund_for", *FOLLOWUP_FIELDS}:
            raise ValueError("Only transaction type, category, and refund details can be edited")
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
            target_kind = changes.get("kind", row["kind"])
            if target_kind not in {"purchase", "refund", "transfer"}:
                raise ValueError("Choose purchase, refund, or transfer")
            allowed = {"kind"}
            if target_kind == "purchase":
                allowed.update({"category", "refund_expected", *FOLLOWUP_FIELDS})
            elif target_kind == "refund":
                allowed.add("refund_for")
            if not set(changes) <= allowed:
                raise ValueError("That field does not apply to this transaction")
            if target_kind != row["kind"]:
                if target_kind != "purchase":
                    row.update(category="", refund_expected=Decimal(0), refund_due="", refund_note="")
                if target_kind != "refund":
                    row["refund_for"] = ""
            row.update(changes)
            checked = parse_transactions(to_csv(rows))
            row = next(row for row in checked if row["id"] == transaction_id)
            db.execute("UPDATE transactions SET kind = ?, category = ?, refund_expected = ?, refund_for = ?, refund_due = ?, refund_note = ? WHERE dataset_id = ? AND id = ?",
                       (row["kind"], row["category"], str(row["refund_expected"]), row["refund_for"], row["refund_due"], row["refund_note"], dataset_id, transaction_id))
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
        static = {"/": (TEMPLATE_DIR / "index.html", "text/html"),
                  "/index.html": (TEMPLATE_DIR / "index.html", "text/html"),
                  "/app.js": (STATIC_DIR / "app.js", "text/javascript"),
                  "/comparison.js": (STATIC_DIR / "comparison.js", "text/javascript"),
                  "/statement-import.js": (STATIC_DIR / "statement-import.js", "text/javascript"),
                  "/theme.js": (STATIC_DIR / "theme.js", "text/javascript"),
                  "/bills.js": (STATIC_DIR / "bills.js", "text/javascript"),
                  "/install.js": (STATIC_DIR / "install.js", "text/javascript"),
                  "/manifest.webmanifest": (STATIC_DIR / "manifest.webmanifest", "application/manifest+json"),
                  "/icon.svg": (STATIC_DIR / "icon.svg", "image/svg+xml"),
                  "/style.css": (STATIC_DIR / "style.css", "text/css")}
        if url.path in static:
            path, content_type = static[url.path]
            self.send(200, path.read_bytes(), content_type + "; charset=utf-8")
            return
        try:
            selected = parse_qs(url.query).get("dataset", [None])[0]
            selected = int(selected) if selected is not None else None
            if url.path == "/api/bills":
                today = bill_date(parse_qs(url.query).get("today", [date.today().isoformat()])[0])
                self.send(200, self.server.store.bills(today))
            elif url.path == "/api/state":
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
            if self.path == "/api/compare":
                self.send(200, self.server.store.comparison(data))
                return
            if self.path == "/api/import/inspect":
                self.send(200, inspect_statement(data.get("csv")))
                return
            if self.path == "/api/import/preview":
                converted = convert_statement(data.get("csv"), data.get("options"))
                self.send(200, {key: value for key, value in converted.items() if key != "csv"})
                return
            if self.path == "/api/bills":
                today = bill_date(data.get("today"))
                self.send(200, self.server.store.update_bill(data, today))
                return
            duplicate = False
            if self.path == "/api/import":
                selected, duplicate = self.server.store.import_csv(data.get("name"), data.get("csv"))
            elif self.path == "/api/import/mapped":
                converted = convert_statement(data.get("csv"), data.get("options"))
                selected, duplicate = self.server.store.import_csv(data.get("name"), converted["csv"])
            elif self.path == "/api/demo":
                selected, duplicate = self.server.store.import_csv(
                    "Student demo", (ROOT / "data" / "raw" / "demo.csv").read_text(encoding="utf-8"))
            elif self.path == "/api/transaction":
                self.server.store.update(data)
                selected = data["dataset_id"]
            else:
                self.send(404, {"error": "Action not found"})
                return
            state = self.server.store.state(selected)
            state["duplicate"] = duplicate
            self.send(200, state)
        except (ConflictError, BillConflictError) as error:
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
