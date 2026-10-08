import http.client
import json
import tempfile
import threading
import unittest
from decimal import Decimal
from pathlib import Path

from app import ConflictError, ROOT, Store, make_server, to_csv
from main import FIELDS, parse_transactions


DEMO = (ROOT / "examples" / "demo.csv").read_text(encoding="utf-8")


class StoreTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name) / "money.db"
        self.store = Store(self.path)
        self.selected, _ = self.store.import_csv("Demo", DEMO)

    def report(self):
        return self.store.state(self.selected)["report"]

    def edit(self, transaction_id, **changes):
        self.store.update({"dataset_id": self.selected, "version": self.report()["dataset"]["version"],
                           "id": transaction_id, "changes": changes})

    def test_demo_totals_and_suggestion(self):
        report = self.report()
        self.assertEqual(report["summary"], {"purchases": Decimal("4480"), "refunds": Decimal("1200"),
                                             "net": Decimal("3280"), "still_due": Decimal("2100")})
        self.assertEqual(report["refund_suggestions"][0]["refund_id"], "d9")

    def test_confirm_link_persists_and_can_be_undone(self):
        self.edit("d9", refund_for="d3")
        reopened = Store(self.path).state(self.selected)["report"]
        self.assertEqual(reopened["summary"]["still_due"], Decimal("1800"))
        self.assertEqual(reopened["watchlist"][0]["status"], "Received")
        self.assertEqual(reopened["summary"]["net"], Decimal("3280"))
        self.edit("d9", refund_for="")
        self.assertEqual(self.report()["summary"]["still_due"], Decimal("2100"))

    def test_category_and_expected_refund_edit(self):
        self.edit("d4", category="Food", refund_expected="100.00")
        self.assertEqual(self.report()["categories"]["Food"], Decimal("560"))
        self.assertEqual(self.report()["summary"]["still_due"], Decimal("2200"))
        self.assertNotIn("d4", self.report()["category_suggestions"])

    def test_reimport_original_preserves_edits(self):
        self.edit("d9", refund_for="d3")
        selected, duplicate = self.store.import_csv("Demo again", DEMO)
        self.assertTrue(duplicate)
        self.assertEqual(selected, self.selected)
        self.assertEqual(len(self.store.state()["datasets"]), 1)
        self.assertEqual(self.report()["summary"]["still_due"], Decimal("1800"))

    def test_imports_with_same_ids_are_isolated(self):
        other, _ = self.store.import_csv("Different statement", DEMO.replace("CAMPUS CAFE", "COLLEGE CAFE"))
        self.store.update({"dataset_id": other, "version": 1, "id": "d9", "changes": {"refund_for": "d3"}})
        self.assertEqual(self.report()["summary"]["still_due"], Decimal("2100"))
        self.assertEqual(self.store.state(other)["report"]["summary"]["still_due"], Decimal("1800"))

    def test_bad_import_does_not_create_partial_dataset(self):
        for data in (DEMO.replace("2026-09-03", "bad-date"), DEMO.replace("2026-09-12", "2026-09-04"), ",".join(FIELDS),
                     DEMO.replace("-240.00", "-240.001"), DEMO.replace("-240.00", "-1e100")):
            with self.subTest(data=data[:60]):
                with self.assertRaises(ValueError):
                    self.store.import_csv("Bad input", data)
                self.assertEqual(len(self.store.state()["datasets"]), 1)

    def test_bad_updates_leave_saved_data_untouched(self):
        before = self.report()
        for transaction_id, changes in (("d9", {"refund_for": "missing"}),
                                         ("d9", {"refund_for": "d7"}),
                                         ("d9", {"refund_for": "d10"}),
                                         ("d3", {"refund_expected": "9999"}),
                                         ("d3", {"refund_expected": "NaN"}),
                                         ("d3", {"refund_for": "d1"}),
                                         ("d7", {"category": "Food"}),
                                         ("d3", {"amount": "10"})):
            with self.subTest(transaction_id=transaction_id, changes=changes):
                with self.assertRaises(ValueError):
                    self.edit(transaction_id, **changes)
                self.assertEqual(self.report(), before)

    def test_stale_tab_cannot_overwrite_a_newer_edit(self):
        self.edit("d4", category="Food")
        with self.assertRaises(ConflictError):
            self.store.update({"dataset_id": self.selected, "version": 1, "id": "d4",
                               "changes": {"category": "Shopping"}})
        self.assertEqual(self.report()["categories"]["Food"], Decimal("560"))

    def test_export_round_trip_keeps_saved_links_and_commas(self):
        self.edit("d4", category="Food, campus")
        self.edit("d9", refund_for="d3")
        rows = parse_transactions(to_csv(self.report()["transactions"]))
        self.assertEqual(next(row["category"] for row in rows if row["id"] == "d4"), "Food, campus")
        self.assertEqual(next(row["refund_for"] for row in rows if row["id"] == "d9"), "d3")

    def test_duplicate_headers_and_extra_fields_are_rejected(self):
        for data in (DEMO.replace("id,date", "id,id"), DEMO.replace("Food,,", "Food,,,extra")):
            with self.assertRaises(ValueError):
                self.store.import_csv("Malformed", data)


class WebTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.server = make_server(Path(self.temp.name) / "web.db", 0)
        self.thread = threading.Thread(target=self.server.serve_forever, kwargs={"poll_interval": 0.01}, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()
        self.temp.cleanup()

    def request(self, path, data=None, extra_headers=None):
        connection = http.client.HTTPConnection("127.0.0.1", self.server.server_port, timeout=5)
        headers = {"Content-Type": "application/json"}
        headers.update(extra_headers or {})
        connection.request("GET" if data is None else "POST", path,
                           None if data is None else json.dumps(data), headers)
        response = connection.getresponse()
        content = response.read().decode("utf-8")
        status, content_type = response.status, response.getheader("Content-Type")
        connection.close()
        return status, json.loads(content) if content_type.startswith("application/json") else content

    def test_browser_workflow_and_export(self):
        status, empty = self.request("/api/state")
        self.assertEqual((status, empty["report"]), (200, None))
        status, loaded = self.request("/api/demo", {})
        self.assertEqual(status, 200)
        dataset = loaded["report"]["dataset"]
        status, saved = self.request("/api/transaction", {"dataset_id": dataset["id"], "version": dataset["version"],
                                                         "id": "d9", "changes": {"refund_for": "d3"}})
        self.assertEqual(status, 200)
        self.assertEqual(saved["report"]["summary"]["still_due"], "1800.00")
        status, exported = self.request("/api/export?dataset=" + str(dataset["id"]))
        self.assertEqual(status, 200)
        self.assertEqual(next(row["refund_for"] for row in parse_transactions(exported) if row["id"] == "d9"), "d3")
        status, page = self.request("/")
        self.assertEqual(status, 200)
        self.assertIn('id="refund-review"', page)

    def test_upload_and_validation_errors(self):
        status, state = self.request("/api/import", {"name": "My CSV", "csv": DEMO})
        self.assertEqual(status, 200)
        status, error = self.request("/api/import", {"name": "Broken", "csv": "hello"})
        self.assertEqual(status, 400)
        self.assertIn("columns", error["error"])
        self.assertEqual(len(self.request("/api/state")[1]["datasets"]), 1)

    def test_conflict_and_local_origin_checks(self):
        self.request("/api/demo", {})
        status, _ = self.request("/api/transaction", {"dataset_id": 1, "version": 0, "id": "d4", "changes": {"category": "Food"}})
        self.assertEqual(status, 409)
        self.assertEqual(self.request("/api/demo", {}, {"Origin": "https://another-site.example"})[0], 403)
        self.assertEqual(self.request("/api/state", extra_headers={"Host": "another-site.example"})[0], 403)
        self.assertEqual(self.request("/data/moneytrail.db")[0], 404)


if __name__ == "__main__":
    unittest.main()
