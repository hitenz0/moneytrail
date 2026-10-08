import csv
import tempfile
import unittest
from decimal import Decimal
from pathlib import Path

from main import FILE, load_transactions, refund_watchlist, suggest_refund_links, summarize


class RefundWatchlistTests(unittest.TestCase):
    def setUp(self):
        with FILE.open(newline="", encoding="utf-8-sig") as file:
            self.rows = list(csv.DictReader(file))

    def load_rows(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "transactions.csv"
            with path.open("w", newline="", encoding="utf-8") as file:
                writer = csv.DictWriter(file, fieldnames=self.rows[0].keys())
                writer.writeheader()
                writer.writerows(self.rows)
            return load_transactions(path)

    def test_sample_partial_refund(self):
        transactions = self.load_rows()
        item, = refund_watchlist(transactions)
        self.assertEqual(item["status"], "Partly received")
        self.assertEqual(item["remaining"], Decimal("300"))
        self.assertEqual(summarize(transactions), (Decimal("1940"), Decimal("900"), Decimal("1040")))

    def test_unlinked_credit_does_not_close_watchlist(self):
        self.rows[4]["refund_for"] = ""
        transactions = self.load_rows()
        item, = refund_watchlist(transactions)
        self.assertEqual(item["status"], "Waiting")
        self.assertEqual(item["remaining"], Decimal("1200"))
        self.assertEqual(summarize(transactions)[2], Decimal("1040"))

    def test_multiple_credits_complete_refund(self):
        self.rows.append({**self.rows[4], "id": "t6", "amount": "300.00"})
        item, = refund_watchlist(self.load_rows())
        self.assertEqual(item["status"], "Received")
        self.assertEqual(item["received"], Decimal("1200"))
        self.assertEqual(item["remaining"], Decimal("0"))

    def test_partial_return_can_be_fully_refunded(self):
        self.rows[2]["refund_expected"] = "900.00"
        item, = refund_watchlist(self.load_rows())
        self.assertEqual(item["status"], "Received")
        self.assertEqual(item["remaining"], Decimal("0"))

    def test_extra_credit_never_makes_remaining_negative(self):
        self.rows[4]["amount"] = "1300.00"
        item, = refund_watchlist(self.load_rows())
        self.assertEqual(item["received"], Decimal("1300"))
        self.assertEqual(item["remaining"], Decimal("0"))

    def test_no_expected_refunds(self):
        self.rows[2]["refund_expected"] = ""
        self.assertEqual(refund_watchlist(self.load_rows()), [])

    def test_credit_cannot_link_to_missing_purchase_or_transfer(self):
        for purchase_id in ("missing", "t4", "t5"):
            with self.subTest(purchase_id=purchase_id):
                self.rows[4]["refund_for"] = purchase_id
                with self.assertRaisesRegex(ValueError, "existing purchase id"):
                    self.load_rows()

    def test_reject_duplicate_ids(self):
        self.rows[4]["id"] = "t3"
        with self.assertRaisesRegex(ValueError, "unique id"):
            self.load_rows()

    def test_reject_invalid_expected_refund(self):
        for amount in ("-1", "1200.01", "NaN", "Infinity"):
            with self.subTest(amount=amount):
                self.rows[2]["refund_expected"] = amount
                with self.assertRaises(ValueError):
                    self.load_rows()

    def test_other_purchases_do_not_receive_this_credit(self):
        self.rows[0]["refund_expected"] = "240.00"
        first, second = refund_watchlist(self.load_rows())
        self.assertEqual(first["remaining"], Decimal("240"))
        self.assertEqual(second["remaining"], Decimal("300"))

    def test_unlinked_bookstore_credit_is_only_a_suggestion(self):
        self.rows[4]["refund_for"] = ""
        transactions = self.load_rows()
        suggestions = suggest_refund_links(transactions)
        self.assertEqual(len(suggestions), 1)
        self.assertEqual((suggestions[0]["refund_id"], suggestions[0]["purchase_id"]), ("t5", "t3"))
        self.assertEqual(suggestions[0]["shared_words"], ["bookstore"])
        self.assertEqual(refund_watchlist(transactions)[0]["remaining"], Decimal("1200"))

    def test_confirmed_credit_is_not_suggested(self):
        self.assertEqual(suggest_refund_links(self.load_rows()), [])

    def test_suggestion_needs_description_date_and_amount(self):
        original = self.rows[4].copy()
        changes = (
            {"description": "CARD REFUND"},
            {"date": "2026-09-04"},
            {"amount": "1200.01"},
        )
        for change in changes:
            with self.subTest(change=change):
                self.rows[4] = {**original, **change, "refund_for": ""}
                self.assertEqual(suggest_refund_links(self.load_rows()), [])
        self.rows[4] = original

    def test_multiple_purchases_can_be_suggested_for_review(self):
        self.rows[0]["description"] = "BOOKSTORE CAFE"
        self.rows[0]["refund_expected"] = "240.00"
        self.rows[4]["refund_for"] = ""
        self.rows[4]["amount"] = "200.00"
        self.assertEqual([item["purchase_id"] for item in suggest_refund_links(self.load_rows())],
                         ["t1", "t3"])

    def test_reject_invalid_date(self):
        self.rows[4]["date"] = "2026-09-99"
        with self.assertRaisesRegex(ValueError, "Line 6"):
            self.load_rows()


if __name__ == "__main__":
    unittest.main()
