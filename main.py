"""Read sample transactions and show MoneyTrail spending totals."""

import csv
from decimal import Decimal, InvalidOperation
from pathlib import Path


FILE = Path(__file__).with_name("sample_transactions.csv")
KINDS = {"purchase", "refund", "transfer"}


def load_transactions(path):
    with path.open(newline="", encoding="utf-8-sig") as file:
        reader = csv.DictReader(file)
        expected = {"id", "date", "description", "amount", "account", "kind", "category",
                    "refund_expected", "refund_for"}
        if not reader.fieldnames or not expected.issubset(reader.fieldnames):
            raise ValueError("CSV needs these columns: " + ", ".join(sorted(expected)))

        transactions = []
        seen_ids = set()
        for line_number, row in enumerate(reader, start=2):
            try:
                if any(row[column] is None for column in expected):
                    raise ValueError("missing CSV fields")
                transaction_id = row["id"].strip()
                amount = Decimal(row["amount"])
                kind = row["kind"].strip().lower()
                category = row["category"].strip()
                refund_expected = Decimal(row["refund_expected"].strip() or "0")
                refund_for = row["refund_for"].strip()
                if not transaction_id or transaction_id in seen_ids:
                    raise ValueError("each transaction needs a unique id")
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
                if not refund_expected.is_finite() or refund_expected < 0:
                    raise ValueError("expected refund must be a finite, non-negative amount")
                if refund_expected > 0 and (kind != "purchase" or refund_expected > -amount):
                    raise ValueError("expected refund must belong to a purchase and cannot exceed its amount")
                if refund_for and kind != "refund":
                    raise ValueError("only a refund can link to a purchase")
            except (ValueError, TypeError, InvalidOperation) as error:
                raise ValueError(f"Line {line_number}: {error}") from error
            seen_ids.add(transaction_id)
            transactions.append({**row, "id": transaction_id, "amount": amount, "kind": kind,
                                 "category": category, "refund_expected": refund_expected,
                                 "refund_for": refund_for})

        purchases = {row["id"] for row in transactions if row["kind"] == "purchase"}
        for row in transactions:
            if row["refund_for"] and row["refund_for"] not in purchases:
                raise ValueError(f"Transaction {row['id']}: refund_for must point to an existing purchase id")
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


def refund_watchlist(transactions):
    received = {}
    for row in transactions:
        if row["kind"] == "refund" and row["refund_for"]:
            purchase_id = row["refund_for"]
            received[purchase_id] = received.get(purchase_id, Decimal(0)) + row["amount"]

    watchlist = []
    for row in transactions:
        if row["kind"] != "purchase" or row["refund_expected"] == 0:
            continue
        paid_back = received.get(row["id"], Decimal(0))
        remaining = max(row["refund_expected"] - paid_back, Decimal(0))
        if remaining == 0:
            status = "Received"
        elif paid_back > 0:
            status = "Partly received"
        else:
            status = "Waiting"
        watchlist.append({"id": row["id"], "description": row["description"],
                          "expected": row["refund_expected"], "received": paid_back,
                          "remaining": remaining, "status": status})
    return watchlist


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

    print("\nRefund watchlist:")
    watchlist = refund_watchlist(rows)
    if not watchlist:
        print("  No purchases marked as waiting for a refund.")
    for item in watchlist:
        print(f"  {item['description']} ({item['id']}) - {item['status']}")
        print(f"    Expected: INR {item['expected']:,.2f} | Received: INR {item['received']:,.2f}"
              f" | Still due: INR {item['remaining']:,.2f}")
    total_due = sum((item["remaining"] for item in watchlist), Decimal(0))
    print(f"Total refunds still due: INR {total_due:,.2f}")
