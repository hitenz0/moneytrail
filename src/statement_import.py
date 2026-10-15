"""Convert a mapped bank statement CSV into MoneyTrail's reviewed CSV format."""

import csv
import io
import re
from datetime import datetime
from decimal import Decimal, InvalidOperation

from .main import FIELDS, parse_transactions


DATE_FORMATS = {"iso": "%Y-%m-%d", "dmy_slash": "%d/%m/%Y",
                "dmy_dash": "%d-%m-%Y", "mdy_slash": "%m/%d/%Y"}
HEADER_HINTS = {
    "date": ("date", "transactiondate", "valuedate", "posteddate"),
    "description": ("description", "narration", "details", "particulars", "merchant"),
    "debit": ("debit", "withdrawal", "withdrawals", "paidout"),
    "credit": ("credit", "deposit", "deposits", "paidin"),
    "amount": ("amount", "transactionamount"),
}
REFUND_WORDS = re.compile(r"\b(refund|reversal|reversed|cashback|chargeback)\b", re.I)
TRANSFER_WORDS = re.compile(r"\b(credit\s*card\s*(bill|payment)|card\s*bill|cc\s*bill|self\s*transfer)\b", re.I)


def read_statement(text):
    if not isinstance(text, str) or len(text.encode("utf-8")) > 2 * 1024 * 1024:
        raise ValueError("Choose a UTF-8 CSV smaller than 2 MB")
    reader = csv.reader(io.StringIO(text.lstrip("\ufeff")), strict=True)
    headers = next(reader, None)
    if not headers or len(headers) > 50 or any(not cell.strip() for cell in headers):
        raise ValueError("Statement needs a header row with 1 to 50 named columns")
    headers = [cell.strip() for cell in headers]
    if len(set(headers)) != len(headers):
        raise ValueError("Statement column names must be unique")
    rows = []
    for line, cells in enumerate(reader, start=2):
        if not cells or all(not cell.strip() for cell in cells):
            continue
        if len(cells) != len(headers):
            raise ValueError(f"Line {line}: expected {len(headers)} columns, found {len(cells)}")
        rows.append((line, dict(zip(headers, cells))))
        if len(rows) > 10000:
            raise ValueError("Import at most 10,000 transactions")
    if not rows:
        raise ValueError("Statement has no transactions")
    return headers, rows


def inspect_statement(text):
    headers, rows = read_statement(text)
    normalized = {header: re.sub(r"[^a-z0-9]", "", header.lower()) for header in headers}
    suggested = {}
    for field, hints in HEADER_HINTS.items():
        suggested[field] = next((header for header in headers if normalized[header] in hints), "")
    first_date = rows[0][1].get(suggested["date"], "")
    suggested["date_format"] = "dmy_slash" if "/" in first_date else "dmy_dash" if re.fullmatch(r"\d{2}-\d{2}-\d{4}", first_date.strip()) else "iso"
    suggested["mode"] = "split" if suggested["debit"] and suggested["credit"] else "signed"
    return {"headers": headers, "count": len(rows), "sample": [row for _, row in rows[:3]],
            "suggested": suggested}


def amount_value(raw, line):
    value = raw.strip().replace(",", "").replace("₹", "")
    value = re.sub(r"^INR\s*", "", value, flags=re.I).strip()
    if value.startswith("(") and value.endswith(")"):
        value = "-" + value[1:-1]
    try:
        amount = Decimal(value)
    except InvalidOperation as error:
        raise ValueError(f"Line {line}: invalid amount {raw!r}") from error
    if not amount.is_finite() or abs(amount) > Decimal("999999999.99") or amount != amount.quantize(Decimal("0.01")):
        raise ValueError(f"Line {line}: amount must be below one billion with at most two decimals")
    return amount


def convert_statement(text, options):
    headers, source_rows = read_statement(text)
    if not isinstance(options, dict):
        raise ValueError("Choose the statement columns")
    mapping = options.get("mapping")
    mode = options.get("mode")
    date_format = options.get("date_format")
    account = options.get("account")
    if not isinstance(mapping, dict) or mode not in {"split", "signed"} or date_format not in DATE_FORMATS:
        raise ValueError("Choose a date format and amount columns")
    if not isinstance(account, str) or not account.strip() or len(account.strip()) > 100:
        raise ValueError("Enter an account name of 1 to 100 characters")
    required = ("date", "description", "debit", "credit") if mode == "split" else ("date", "description", "amount")
    chosen = [mapping.get(field) for field in required]
    if any(not isinstance(name, str) or name not in headers for name in chosen) or len(set(chosen)) != len(chosen):
        raise ValueError("Map each required field to a different statement column")
    output = io.StringIO(newline="")
    writer = csv.DictWriter(output, fieldnames=FIELDS)
    writer.writeheader()
    sample = []
    counts = {"purchase": 0, "refund": 0, "transfer": 0}
    for index, (line, row) in enumerate(source_rows, start=1):
        try:
            transaction_date = datetime.strptime(row[mapping["date"]].strip(), DATE_FORMATS[date_format]).date().isoformat()
        except ValueError as error:
            raise ValueError(f"Line {line}: date does not match the selected format") from error
        description = row[mapping["description"]].strip()
        if not description:
            raise ValueError(f"Line {line}: description is blank")
        if mode == "signed":
            amount = amount_value(row[mapping["amount"]], line)
        else:
            debit_raw = row[mapping["debit"]].strip()
            credit_raw = row[mapping["credit"]].strip()
            debit = amount_value(debit_raw, line) if debit_raw else Decimal(0)
            credit = amount_value(credit_raw, line) if credit_raw else Decimal(0)
            if debit < 0 or credit < 0 or bool(debit) == bool(credit):
                raise ValueError(f"Line {line}: enter a positive debit or credit, but not both")
            amount = credit - debit
        if not amount:
            raise ValueError(f"Line {line}: amount cannot be zero")
        if amount > 0:
            kind = "refund" if REFUND_WORDS.search(description) else "transfer"
        else:
            kind = "transfer" if TRANSFER_WORDS.search(description) else "purchase"
        converted = {"id": f"statement-{index}", "date": transaction_date,
                     "description": description, "amount": str(amount), "account": account.strip(),
                     "kind": kind, "category": "", "refund_expected": "", "refund_for": ""}
        writer.writerow(converted)
        counts[kind] += 1
        if len(sample) < 8:
            sample.append(converted)
    converted_csv = output.getvalue()
    parse_transactions(converted_csv)
    return {"csv": converted_csv, "sample": sample, "counts": counts, "count": len(source_rows)}
