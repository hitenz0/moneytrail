"""Saved bill schedules and calendar-based recurrence. No payments are sent."""

import calendar
import re
from datetime import date, timedelta
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP


CADENCES = {"once", "weekly", "monthly", "quarterly", "yearly"}
PAYMENT_METHODS = {"manual", "autopay"}


class BillConflictError(ValueError):
    pass


def bill_date(value):
    if not isinstance(value, str) or not re.fullmatch(r"[0-9]{4}-[0-9]{2}-[0-9]{2}", value):
        raise ValueError("Choose a bill date in YYYY-MM-DD format")
    try:
        return date.fromisoformat(value)
    except ValueError as error:
        raise ValueError("Choose a valid bill date") from error


def create_bill_table(db):
    db.execute("""CREATE TABLE IF NOT EXISTS bills (
        id INTEGER PRIMARY KEY, name TEXT NOT NULL, amount TEXT NOT NULL,
        cadence TEXT NOT NULL, next_due TEXT NOT NULL, note TEXT NOT NULL DEFAULT '',
        payment_method TEXT NOT NULL DEFAULT 'manual',
        status TEXT NOT NULL DEFAULT 'active', anchor_day INTEGER NOT NULL,
        anchor_month INTEGER NOT NULL, version INTEGER NOT NULL DEFAULT 1,
        last_paid_due TEXT NOT NULL DEFAULT '', last_paid_on TEXT NOT NULL DEFAULT ''
    )""")
    columns = {row["name"] for row in db.execute("PRAGMA table_info(bills)")}
    if "payment_method" not in columns:
        db.execute("ALTER TABLE bills ADD COLUMN payment_method TEXT NOT NULL DEFAULT 'manual'")


def next_bill_date(row):
    current = bill_date(row["next_due"])
    try:
        if row["cadence"] == "weekly":
            return (current + timedelta(days=7)).isoformat()
        months = {"monthly": 1, "quarterly": 3, "yearly": 12}[row["cadence"]]
        year, month = divmod(current.year * 12 + current.month - 1 + months, 12)
        month += 1
        day = min(row["anchor_day"], calendar.monthrange(year, month)[1])
        return date(year, month, day).isoformat()
    except (ValueError, OverflowError) as error:
        raise ValueError("The next payment date is outside the supported calendar; edit this bill's date") from error


def bill_report(db, today):
    rows = [dict(row) for row in db.execute("SELECT * FROM bills ORDER BY next_due, id")]
    monthly = Decimal(0)
    upcoming = Decimal(0)
    overdue = Decimal(0)
    active_count = overdue_count = 0
    for row in rows:
        amount = Decimal(row["amount"])
        row["days_until"] = (bill_date(row["next_due"]) - today).days
        if row["status"] != "active":
            continue
        active_count += 1
        if row["cadence"] == "weekly":
            monthly += amount * 52 / 12
        elif row["cadence"] == "monthly":
            monthly += amount
        elif row["cadence"] == "quarterly":
            monthly += amount / 3
        elif row["cadence"] == "yearly":
            monthly += amount / 12
        if 0 <= row["days_until"] < 7:
            upcoming += amount
        elif row["days_until"] < 0:
            overdue += amount
            overdue_count += 1
    return {"today": today.isoformat(), "items": rows, "summary": {
        "monthly": monthly.quantize(Decimal("0.01"), rounding=ROUND_HALF_UP),
        "next_seven": upcoming, "overdue": overdue,
        "active_count": active_count, "overdue_count": overdue_count}}


def save_bill(db, data, today):
    action = data.get("action")
    if not isinstance(action, str) or action not in {"save", "pay", "undo", "pause", "resume"}:
        raise ValueError("Choose a valid bill action")
    row = None
    if data.get("id") is not None:
        if type(data["id"]) is not int or type(data.get("version")) is not int:
            raise ValueError("Choose a saved bill")
        found = db.execute("SELECT * FROM bills WHERE id = ?", (data["id"],)).fetchone()
        if found is None:
            raise ValueError("That bill no longer exists")
        row = dict(found)
        if row["version"] != data["version"]:
            raise BillConflictError("This bill changed in another tab. Reload the page before saving again.")
    elif action != "save":
        raise ValueError("Choose a saved bill")

    if action == "save":
        fields = data.get("fields")
        if not isinstance(fields, dict) or set(fields) != {"name", "amount", "cadence", "next_due", "note", "payment_method"}:
            raise ValueError("Enter the bill name, amount, frequency, next date, payment method, and optional note")
        if any(not isinstance(value, str) or len(value) > 200 for value in fields.values()):
            raise ValueError("Bill details must be text of at most 200 characters")
        name, note = fields["name"].strip(), fields["note"].strip()
        if not name or len(name) > 100:
            raise ValueError("Give the bill a name of 1 to 100 characters")
        cadence = fields["cadence"]
        if cadence not in CADENCES:
            raise ValueError("Choose one-time, weekly, monthly, quarterly, or yearly")
        payment_method = fields["payment_method"]
        if payment_method not in PAYMENT_METHODS:
            raise ValueError("Choose manual payment or autopay")
        due = bill_date(fields["next_due"])
        try:
            amount = Decimal(fields["amount"])
            if not amount.is_finite() or not 0 < amount < 1000000000 or amount != amount.quantize(Decimal("0.01")):
                raise ValueError("Enter a positive amount below one billion INR with at most two decimal places")
        except InvalidOperation as error:
            raise ValueError("Enter a valid bill amount") from error
        amount = str(amount.quantize(Decimal("0.01")))
        if row is None:
            db.execute("""INSERT INTO bills (name, amount, cadence, next_due, note, payment_method, anchor_day, anchor_month)
                          VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
                       (name, amount, cadence, due.isoformat(), note, payment_method, due.day, due.month))
        else:
            changed_schedule = due.isoformat() != row["next_due"] or cadence != row["cadence"]
            anchor = due.day if changed_schedule else row["anchor_day"]
            anchor_month = due.month if changed_schedule else row["anchor_month"]
            status = "active" if changed_schedule and row["status"] == "paid" else row["status"]
            db.execute("""UPDATE bills SET name=?, amount=?, cadence=?, next_due=?, note=?, payment_method=?,
                          anchor_day=?, anchor_month=?, status=?, last_paid_due=?, last_paid_on=?,
                          version=version+1 WHERE id=?""",
                       (name, amount, cadence, due.isoformat(), note, payment_method, anchor, anchor_month, status,
                        "" if changed_schedule else row["last_paid_due"],
                        "" if changed_schedule else row["last_paid_on"], row["id"]))
        return

    if action == "pay":
        if row["status"] != "active":
            raise ValueError("Only active bills can be marked paid")
        next_due = row["next_due"] if row["cadence"] == "once" else next_bill_date(row)
        status = "paid" if row["cadence"] == "once" else "active"
        db.execute("""UPDATE bills SET next_due=?, status=?, last_paid_due=?, last_paid_on=?,
                      version=version+1 WHERE id=?""",
                   (next_due, status, row["next_due"], today.isoformat(), row["id"]))
    elif action == "undo":
        if not row["last_paid_due"]:
            raise ValueError("There is no recent payment to undo")
        status = "paused" if row["status"] == "paused" else "active"
        db.execute("""UPDATE bills SET next_due=?, status=?, last_paid_due='', last_paid_on='',
                      version=version+1 WHERE id=?""", (row["last_paid_due"], status, row["id"]))
    else:
        required_status = "active" if action == "pause" else "paused"
        if row["status"] != required_status:
            raise ValueError("Reload the page to see this bill's current status")
        db.execute("UPDATE bills SET status=?, version=version+1 WHERE id=?",
                   ("paused" if action == "pause" else "active", row["id"]))
