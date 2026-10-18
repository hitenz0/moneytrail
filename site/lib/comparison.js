import { cents, daysBetween, fail, isoDate, money, summary } from "./core.js";

function period(value) {
  if (!value || !Number.isInteger(value.dataset_id)) fail("Choose a saved import for each period");
  const start = isoDate(value.start, "start date"), end = isoDate(value.end, "end date");
  const days = daysBetween(start, end) + 1;
  if (days < 1) fail("A period's end date must be on or after its start");
  return { dataset_id: value.dataset_id, start, end, days };
}

export function validatePeriods(data) {
  const before = period(data?.before), after = period(data?.after);
  if (before.days !== after.days) fail("Choose the same number of days in both periods for a fair comparison");
  if (before.end >= after.start) fail("The earlier period must end before the later period starts");
  return [before, after];
}

function periodReport(rows, selectedPeriod, dataset) {
  const selected = rows.filter(row => selectedPeriod.start <= row.date && row.date <= selectedPeriod.end);
  const grouped = new Map();
  for (const row of selected) if (row.kind === "purchase") {
    const name = row.category || "Uncategorized";
    if (!grouped.has(name)) grouped.set(name, []);
    grouped.get(name).push(row);
  }
  const observed = rows.map(row => row.date).sort();
  return [{ ...selectedPeriod, dataset, summary: { ...summary(selected), count: [...grouped.values()].reduce((n, items) => n + items.length, 0) },
    transaction_count: selected.length, outside_observed_dates: !observed.length || selectedPeriod.start < observed[0] || selectedPeriod.end > observed.at(-1),
    accounts: [...new Set(selected.map(row => row.account))].sort(), refund_transactions: selected.filter(row => row.kind === "refund") }, grouped];
}

function categoryReport(rows) {
  const total = rows.reduce((sum, row) => sum - cents(row.amount), 0);
  return { total: money(total), count: rows.length,
    average: rows.length ? money(Math.round(total / rows.length)) : null,
    transactions: [...rows].sort((a, b) => cents(a.amount) - cents(b.amount) || a.date.localeCompare(b.date) || a.id.localeCompare(b.id)) };
}

export function compare(beforeRows, afterRows, before, after, beforeDataset, afterDataset) {
  const [earlier, leftGroups] = periodReport(beforeRows, before, beforeDataset);
  const [later, rightGroups] = periodReport(afterRows, after, afterDataset);
  const names = new Set([...leftGroups.keys(), ...rightGroups.keys()]);
  const categories = [...names].map(name => {
    const left = categoryReport(leftGroups.get(name) || []), right = categoryReport(rightGroups.get(name) || []);
    return { name, before: left, after: right, change: money(cents(right.total) - cents(left.total)) };
  });
  categories.sort((a, b) => Math.abs(cents(b.change)) - Math.abs(cents(a.change)) || a.name.toLowerCase().localeCompare(b.name.toLowerCase()) || a.name.localeCompare(b.name));
  const changes = Object.fromEntries(["purchases", "refunds", "net"].map(key => [key, money(cents(later.summary[key]) - cents(earlier.summary[key]))]));
  changes.count = later.summary.count - earlier.summary.count;
  return { before: earlier, after: later, changes, categories };
}
