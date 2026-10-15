import tempfile
import unittest
from pathlib import Path

from src.app import Store
from src.statement_import import convert_statement, inspect_statement


SPLIT = """Transaction Date,Narration,Withdrawal,Deposit
14/10/2026,UPI CANTEEN,"1,250.00",
15/10/2026,BOOKSTORE REFUND,,300.00
15/10/2026,MONEY FROM HOME,,5000.00
16/10/2026,CREDIT CARD BILL PAYMENT,800.00,
"""
OPTIONS = {"mode": "split", "date_format": "dmy_slash", "account": "Campus bank",
           "mapping": {"date": "Transaction Date", "description": "Narration",
                       "debit": "Withdrawal", "credit": "Deposit"}}


class StatementImportTests(unittest.TestCase):
    def test_split_statement_preview_and_saved_totals(self):
        inspection = inspect_statement(SPLIT)
        self.assertEqual(inspection["count"], 4)
        self.assertEqual(inspection["suggested"]["mode"], "split")
        converted = convert_statement(SPLIT, OPTIONS)
        self.assertEqual(converted["counts"], {"purchase": 1, "refund": 1, "transfer": 2})
        self.assertEqual(converted["sample"][0]["amount"], "-1250.00")
        with tempfile.TemporaryDirectory() as temp:
            store = Store(Path(temp) / "money.db")
            dataset, duplicate = store.import_csv("Bank", converted["csv"])
            self.assertFalse(duplicate)
            self.assertEqual(store.state(dataset)["report"]["summary"]["net"], 950)
            self.assertEqual(store.import_csv("Bank again", convert_statement(SPLIT, OPTIONS)["csv"]),
                             (dataset, True))

    def test_signed_amount_and_date_format(self):
        csv = "Date,Details,Amount\n2026-10-14,Cafe,-75.50\n2026-10-15,Cafe refund,75.50\n"
        options = {"mode": "signed", "date_format": "iso", "account": "Card",
                   "mapping": {"date": "Date", "description": "Details", "amount": "Amount"}}
        converted = convert_statement(csv, options)
        self.assertEqual(converted["counts"], {"purchase": 1, "refund": 1, "transfer": 0})
        self.assertEqual(converted["sample"][0]["date"], "2026-10-14")

    def test_bad_mapping_or_row_is_rejected_before_save(self):
        broken = [
            (SPLIT, {**OPTIONS, "mapping": {**OPTIONS["mapping"], "credit": "Withdrawal"}}),
            (SPLIT.replace("14/10/2026", "10/14/2026"), OPTIONS),
            (SPLIT.replace("1,250.00", "1,250.001"), OPTIONS),
            (SPLIT.replace("MONEY FROM HOME,,5000.00", "MONEY FROM HOME,50.00,5000.00"), OPTIONS),
            (SPLIT.replace("UPI CANTEEN", ""), OPTIONS),
        ]
        for csv, options in broken:
            with self.subTest(csv=csv[:90], options=options):
                with self.assertRaises(ValueError):
                    convert_statement(csv, options)

    def test_malformed_statement_has_no_silent_row_loss(self):
        for csv in ("A,A\n1,2\n", "Date,Amount\n2026-10-14\n", "Date,Amount\n\n"):
            with self.subTest(csv=csv):
                with self.assertRaises(ValueError):
                    inspect_statement(csv)
