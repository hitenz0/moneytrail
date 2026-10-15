"""Comparison arithmetic, boundaries and storage integration."""
import tempfile
import unittest
from decimal import Decimal
from pathlib import Path

from src.app import ROOT, Store, to_csv
from src.comparison import validate_periods
from src.main import parse_transactions

SAMPLE = (ROOT / "data/raw/spending_comparison.csv").read_text(encoding="utf-8")


def periods(dataset_id=1):
    return {"before": {"dataset_id": dataset_id, "start": "2026-08-01", "end": "2026-08-28"},
            "after": {"dataset_id": dataset_id, "start": "2026-09-01", "end": "2026-09-28"}}


class ComparisonTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.store = Store(Path(self.temp.name) / "comparison.db")
        self.dataset_id, _ = self.store.import_csv("Synthetic comparison", SAMPLE)

    def test_changes_exclude_transfers_and_separate_refunds(self):
        report = self.store.comparison(periods(self.dataset_id))
        self.assertEqual(report["before"]["summary"]["purchases"], Decimal("1299"))
        self.assertEqual(report["after"]["summary"]["purchases"], Decimal("3599"))
        self.assertEqual(report["changes"], {"purchases": Decimal("2300"), "refunds": Decimal("500"),
                                             "net": Decimal("1800"), "count": 2})
        categories = {row["name"]: row for row in report["categories"]}
        self.assertEqual(report["categories"][0]["name"], "Shopping")
        self.assertEqual(categories["Food"]["change"], Decimal("800"))
        self.assertEqual(categories["Food"]["before"]["count"], 2)
        self.assertEqual(categories["Food"]["after"]["count"], 4)
        self.assertEqual(categories["Food"]["before"]["average"], Decimal("200"))
        self.assertEqual(categories["Food"]["after"]["average"], Decimal("300"))
        self.assertEqual(categories["Shopping"]["before"]["average"], None)
        self.assertEqual(categories["Study"]["after"]["count"], 0)
        self.assertEqual(sum((row["change"] for row in report["categories"]), Decimal(0)), report["changes"]["purchases"])
        self.assertEqual(report["after"]["refund_transactions"][0]["id"], "s12")

    def test_period_validation(self):
        for side, key, value in [("before", "start", "2026-02-30"), ("before", "start", "20260801"),
                                 ("before", "start", None), ("before", "end", "2026-07-31"),
                                 ("before", "dataset_id", True), ("after", "end", "2026-09-29")]:
            with self.subTest(value=value):
                data = periods()
                data[side][key] = value
                with self.assertRaises(ValueError):
                    self.store.comparison(data)
        for bad in ({}, {"before": None, "after": []}):
            with self.assertRaises(ValueError):
                self.store.comparison(bad)
        overlapping = periods()
        overlapping["after"] = dict(overlapping["before"])
        with self.assertRaisesRegex(ValueError, "earlier period"):
            self.store.comparison(overlapping)
        with self.assertRaisesRegex(ValueError, "no longer exists"):
            self.store.comparison(periods(999))

    def test_leap_days_and_inclusive_single_day_ranges(self):
        before, after = validate_periods({"before": {"dataset_id": 1, "start": "2024-02-01", "end": "2024-02-29"},
                                          "after": {"dataset_id": 1, "start": "2024-03-01", "end": "2024-03-29"}})
        self.assertEqual(before["days"], 29)
        data = periods()
        data["before"].update(start="2026-08-01", end="2026-08-01")
        data["after"].update(start="2026-09-01", end="2026-09-01")
        report = self.store.comparison(data)
        self.assertEqual(report["changes"]["purchases"], Decimal("30"))
        self.assertEqual(report["before"]["days"], 1)

    def test_two_imports_keep_sources_separate_and_use_saved_edits(self):
        rows = parse_transactions(SAMPLE)
        earlier_id, _ = self.store.import_csv("August", to_csv(rows[:5]))
        data = periods()
        data["before"]["dataset_id"] = earlier_id
        self.store.update({"dataset_id": earlier_id, "version": 1, "id": "s1", "changes": {"category": "Lunch"}})
        report = self.store.comparison(data)
        lunch = next(row for row in report["categories"] if row["name"] == "Lunch")
        self.assertEqual(lunch["change"], Decimal("-150"))
        self.assertEqual(report["before"]["dataset"]["version"], 2)
        self.assertEqual(report["after"]["summary"]["purchases"], Decimal("3599"))
        self.assertEqual(self.store.state(earlier_id)["report"]["dataset"]["first_date"], "2026-08-01")

    def test_empty_range_is_flagged_not_assumed_complete(self):
        data = periods()
        data["before"].update(start="2026-07-01", end="2026-07-28")
        report = self.store.comparison(data)
        self.assertEqual(report["before"]["transaction_count"], 0)
        self.assertTrue(report["before"]["outside_observed_dates"])
        self.assertEqual(report["before"]["summary"]["purchases"], Decimal(0))
        self.assertFalse(report["after"]["outside_observed_dates"])

    def test_decimal_values_and_uncategorized_purchases(self):
        rows = parse_transactions(SAMPLE)
        rows[0].update(amount=Decimal("-0.10"), category="")
        rows[1].update(amount=Decimal("-0.11"), category="")
        dataset_id, _ = self.store.import_csv("Cents", to_csv(rows))
        report = self.store.comparison(periods(dataset_id))
        item = next(item for item in report["categories"] if item["name"] == "Uncategorized")
        self.assertEqual(item["before"]["total"], Decimal("0.21"))
        self.assertEqual(item["before"]["average"], Decimal("0.11"))
        self.assertEqual(item["change"], Decimal("-0.21"))


if __name__ == "__main__":
    unittest.main()
