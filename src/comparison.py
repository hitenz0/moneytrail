"""Explain changes in imported spending across two equal calendar periods."""

from datetime import date
from decimal import Decimal, ROUND_HALF_UP

from .main import summarize


def comparison_period(value):
    if not isinstance(value, dict) or type(value.get("dataset_id")) is not int:
        raise ValueError("Choose a saved import for each period")
    dates = []
    for field in ("start", "end"):
        text = value.get(field)
        try:
            parsed = date.fromisoformat(text) if isinstance(text, str) else None
        except ValueError:
            parsed = None
        if parsed is None or parsed.isoformat() != text:
            raise ValueError("Enter valid start and end dates as YYYY-MM-DD")
        dates.append(parsed)
    if dates[1] < dates[0]:
        raise ValueError("A period's end date must be on or after its start")
    return {"dataset_id": value["dataset_id"], "start": dates[0].isoformat(),
            "end": dates[1].isoformat(), "days": (dates[1] - dates[0]).days + 1}


def validate_periods(data):
    before = comparison_period(data.get("before"))
    after = comparison_period(data.get("after"))
    if before["days"] != after["days"]:
        raise ValueError("Choose the same number of days in both periods for a fair comparison")
    if before["end"] >= after["start"]:
        raise ValueError("The earlier period must end before the later period starts")
    return before, after


def period_report(rows, period, dataset):
    selected = [row for row in rows if period["start"] <= row["date"] <= period["end"]]
    purchases, refunds, net = summarize(selected)
    grouped = {}
    for row in selected:
        if row["kind"] == "purchase":
            grouped.setdefault(row["category"] or "Uncategorized", []).append(row)
    observed = [row["date"] for row in rows]
    return {**period, "dataset": dataset, "summary": {
        "purchases": purchases, "refunds": refunds, "net": net,
        "count": sum(len(items) for items in grouped.values())},
        "transaction_count": len(selected),
        "outside_observed_dates": period["start"] < min(observed) or period["end"] > max(observed),
        "accounts": sorted({row["account"] for row in selected}),
        "refund_transactions": [row for row in selected if row["kind"] == "refund"]}, grouped


def category_report(rows):
    total = sum((-row["amount"] for row in rows), Decimal(0))
    return {"total": total, "count": len(rows),
            "average": (total / len(rows)).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP) if rows else None,
            "transactions": sorted(rows, key=lambda row: (row["amount"], row["date"], row["id"]))}


def compare(before_rows, after_rows, before, after, before_dataset, after_dataset):
    earlier, earlier_groups = period_report(before_rows, before, before_dataset)
    later, later_groups = period_report(after_rows, after, after_dataset)
    categories = []
    for name in earlier_groups.keys() | later_groups.keys():
        left = category_report(earlier_groups.get(name, []))
        right = category_report(later_groups.get(name, []))
        categories.append({"name": name, "before": left, "after": right,
                           "change": right["total"] - left["total"]})
    categories.sort(key=lambda item: (-abs(item["change"]), item["name"].casefold(), item["name"]))
    changes = {key: later["summary"][key] - earlier["summary"][key]
               for key in ("purchases", "refunds", "net", "count")}
    return {"before": earlier, "after": later, "changes": changes, "categories": categories}
