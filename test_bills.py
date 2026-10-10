import http.client
import json
import sqlite3
import tempfile
import threading
import unittest
from contextlib import closing
from datetime import date
from decimal import Decimal
from pathlib import Path

from app import Store, make_server
from bills import BillConflictError


TODAY = date(2026, 10, 10)


class BillTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name) / "bills.db"
        self.store = Store(self.path)

    def fields(self, **changes):
        return {**{"name": "Internet", "amount": "999.00", "cadence": "monthly",
                   "next_due": "2026-10-16", "payment_method": "autopay", "note": "Card"}, **changes}

    def add(self, **changes):
        self.store.update_bill({"action": "save", "fields": self.fields(**changes)}, TODAY)
        return max(self.store.bills(TODAY)["items"], key=lambda item: item["id"])

    def change(self, item, action, **extra):
        return self.store.update_bill({"action": action, "id": item["id"],
                                       "version": item["version"], **extra}, TODAY)

    def test_bills_work_without_a_transaction_import_and_survive_restart(self):
        self.assertEqual(self.store.state()["report"], None)
        item = self.add(note="Reference 42")
        reopened = Store(self.path).bills(TODAY)
        self.assertEqual(len(reopened["items"]), 1)
        self.assertEqual((reopened["items"][0]["name"], reopened["items"][0]["payment_method"],
                          reopened["items"][0]["note"]), ("Internet", "autopay", "Reference 42"))
        self.assertEqual(item["days_until"], 6)
        self.assertEqual(self.store.state()["report"], None)

    def test_next_seven_days_and_overdue_are_separate(self):
        self.add(name="Due today", amount="100.00", next_due="2026-10-10")
        self.add(name="Day six", amount="200.00", next_due="2026-10-16")
        self.add(name="Day seven", amount="300.00", next_due="2026-10-17")
        self.add(name="Past", amount="400.00", next_due="2026-10-09", cadence="once")
        summary = self.store.bills(TODAY)["summary"]
        self.assertEqual(summary["next_seven"], Decimal("300.00"))
        self.assertEqual((summary["overdue"], summary["overdue_count"]), (Decimal("400.00"), 1))
        self.assertEqual(summary["monthly"], Decimal("600.00"))

    def test_monthly_average_excludes_paused_and_one_time(self):
        self.add(name="Weekly", amount="12.00", cadence="weekly")
        yearly = self.add(name="Yearly", amount="120.00", cadence="yearly")
        self.add(name="Quarterly", amount="30.00", cadence="quarterly")
        self.add(name="One time", amount="500.00", cadence="once")
        self.assertEqual(self.store.bills(TODAY)["summary"]["monthly"], Decimal("72.00"))
        self.change(yearly, "pause")
        self.assertEqual(self.store.bills(TODAY)["summary"]["monthly"], Decimal("62.00"))

    def test_end_of_month_payment_keeps_original_day_and_undoes(self):
        item = self.add(next_due="2027-01-31")
        report = self.change(item, "pay")
        item = report["items"][0]
        self.assertEqual((item["next_due"], item["last_paid_due"]), ("2027-02-28", "2027-01-31"))
        report = self.change(item, "pay")
        item = report["items"][0]
        self.assertEqual(item["next_due"], "2027-03-31")
        item = self.change(item, "undo")["items"][0]
        self.assertEqual((item["next_due"], item["status"], item["last_paid_due"]),
                         ("2027-02-28", "active", ""))

    def test_leap_year_yearly_payment_and_weekly_step(self):
        yearly = self.add(next_due="2024-02-29", cadence="yearly")
        for expected in ("2025-02-28", "2026-02-28", "2027-02-28", "2028-02-29"):
            yearly = self.change(yearly, "pay")["items"][0]
            self.assertEqual(yearly["next_due"], expected)
        weekly = self.add(name="Weekly", next_due="2026-10-10", cadence="weekly")
        weekly = next(row for row in self.change(weekly, "pay")["items"] if row["id"] == weekly["id"])
        self.assertEqual(weekly["next_due"], "2026-10-17")

    def test_one_time_payment_pause_resume_and_undo(self):
        item = self.add(cadence="once", next_due="2026-10-09", payment_method="manual")
        item = self.change(item, "pause")["items"][0]
        self.assertEqual(self.store.bills(TODAY)["summary"]["overdue"], Decimal(0))
        item = self.change(item, "resume")["items"][0]
        item = self.change(item, "pay")["items"][0]
        self.assertEqual((item["status"], item["last_paid_on"]), ("paid", TODAY.isoformat()))
        self.assertEqual(self.store.bills(TODAY)["summary"]["overdue"], Decimal(0))
        item = self.change(item, "undo")["items"][0]
        self.assertEqual((item["status"], item["next_due"]), ("active", "2026-10-09"))
        self.assertEqual(self.store.bills(TODAY)["summary"]["overdue"], Decimal("999.00"))

    def test_invalid_actions_are_atomic_and_stale_tab_is_rejected(self):
        item = self.add()
        before = self.store.bills(TODAY)
        bad_fields = [self.fields(amount="NaN"), self.fields(amount="0"),
                      self.fields(amount="2.001"), self.fields(next_due="2026-02-30"),
                      self.fields(payment_method="bank-connected"), self.fields(name="x" * 101)]
        for fields in bad_fields:
            with self.subTest(fields=fields):
                with self.assertRaises(ValueError):
                    self.change(item, "save", fields=fields)
                self.assertEqual(self.store.bills(TODAY), before)
        self.change(item, "pause")
        with self.assertRaises(BillConflictError):
            self.change(item, "pay")
        self.assertEqual(self.store.bills(TODAY)["items"][0]["status"], "paused")

    def test_existing_bill_table_gets_payment_method_column(self):
        old_path = Path(self.temp.name) / "old.db"
        with closing(sqlite3.connect(old_path)) as db, db:
            db.execute("""CREATE TABLE bills (id INTEGER PRIMARY KEY, name TEXT, amount TEXT,
                cadence TEXT, next_due TEXT, note TEXT, status TEXT, anchor_day INTEGER,
                anchor_month INTEGER, version INTEGER, last_paid_due TEXT, last_paid_on TEXT)""")
            db.execute("INSERT INTO bills VALUES (1,'Old bill','50.00','monthly','2026-10-11','', 'active',11,10,1,'','')")
        self.assertEqual(Store(old_path).bills(TODAY)["items"][0]["payment_method"], "manual")


class BillApiTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.server = make_server(Path(self.temp.name) / "api.db", 0)
        self.thread = threading.Thread(target=self.server.serve_forever, kwargs={"poll_interval": .01}, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()
        self.temp.cleanup()

    def request(self, route, body=None):
        connection = http.client.HTTPConnection("127.0.0.1", self.server.server_port, timeout=5)
        connection.request("GET" if body is None else "POST", route,
                           None if body is None else json.dumps(body), {"Content-Type": "application/json"})
        response = connection.getresponse()
        raw = response.read().decode("utf-8")
        connection.close()
        return response.status, json.loads(raw) if response.getheader("Content-Type").startswith("application/json") else raw

    def test_api_add_pay_and_undo_without_import(self):
        self.assertEqual(self.request("/api/bills?today=2026-10-10")[1]["items"], [])
        fields = {"name": "Music", "amount": "199.00", "cadence": "monthly",
                  "next_due": "2026-10-12", "payment_method": "autopay", "note": "Card"}
        status, saved = self.request("/api/bills", {"action": "save", "fields": fields, "today": "2026-10-10"})
        self.assertEqual(status, 200)
        self.assertEqual(saved["summary"]["next_seven"], "199.00")
        item = saved["items"][0]
        status, paid = self.request("/api/bills", {"action": "pay", "id": item["id"],
                            "version": item["version"], "today": "2026-10-10"})
        self.assertEqual(status, 200)
        self.assertEqual(paid["items"][0]["next_due"], "2026-11-12")
        self.assertEqual(paid["summary"]["next_seven"], "0")
        self.assertEqual(self.request("/api/state")[1]["report"], None)
        self.assertEqual(self.request("/bills.js")[0], 200)
        self.assertEqual(self.request("/api/bills?today=2026-13-10")[0], 400)


if __name__ == "__main__":
    unittest.main()
