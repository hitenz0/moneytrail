"""Read sample transactions and show MoneyTrail spending totals."""

import csv
from decimal import Decimal, InvalidOperation
from pathlib import Path


FILE = Path(__file__).with_name("sample_transactions.csv")
KINDS = {"purchase", "refund", "transfer"}


def load_transactions(path):
    with path.open(newline="", encoding="utf-8-sig") as file:
        reader = csv.DictReader(file)
        expected = {"date", "description", "amount", "account", "kind", "category"}
        if not reader.fieldnames or not expected.issubset(reader.fieldnames):
            raise ValueError("CSV needs date, description, amount, account, kind, and category columns")

        transactions = []
        for line_number, row in enumerate(reader, start=2):
            try:
                amount = Decimal(row["amount"])
                kind = row["kind"].strip().lower()
                category = row["category"].strip()
                if not amount.is_finite():
                    raise ValueError("amount must be a number")
                if kind not in KINDS:
                    raise ValueError(f"unknown kind: {kind}")
                if kind == "purchase" and amount >= 0:
                    raise ValueError("a purchase must have a negative amount")
                if kind == "purchase" and not category:
                    raise ValueError("a purchase needs a category")
                if kind == "refund" and amount <= 0:
                    raise ValueError("a refund must have a positive amount")
            except (ValueError, TypeError, InvalidOperation) as error:
                raise ValueError(f"Line {line_number}: {error}") from error
            transactions.append({**row, "amount": amount, "kind": kind, "category": category})
        return transactions


def summarize(transactions):
    gross = -sum((row["amount"] for row in transactions if row["kind"] == "purchase"), Decimal(0))
    refunds = sum((row["amount"] for row in transactions if row["kind"] == "refund"), Decimal(0))
    return gross, refunds, gross - refunds


def spending_by_category(transactions):
    totals = {}
    for row in transactions:
        if row["kind"] == "purchase":
            category = row["category"]
            totals[category] = totals.get(category, Decimal(0)) - row["amount"]
    return totals


if __name__ == "__main__":
    rows = load_transactions(FILE)
    gross, refunds, net = summarize(rows)
    print(f"Loaded {len(rows)} transactions")
    print(f"Purchases:         INR {gross:,.2f}")
    print(f"Refunds received:  INR {refunds:,.2f}")
    print(f"Net spending:      INR {net:,.2f}")
    print("\nPurchases by category:")
    for category, amount in sorted(spending_by_category(rows).items(), key=lambda item: -item[1]):
        print(f"  {category}: INR {amount:,.2f}")
