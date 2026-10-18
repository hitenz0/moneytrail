import assert from "node:assert/strict";
import test from "node:test";
import { categories, parseTransactions, report, toCsv } from "../lib/core.js";
import { compare, validatePeriods } from "../lib/comparison.js";
import { demoCsv } from "../lib/demo.js";
import { convertStatement, inspectStatement } from "../lib/statement.js";

test("demo calculations and a confirmed partial refund keep spending unchanged", () => {
  const rows = parseTransactions(demoCsv);
  const original = report({ id: 1 }, rows);
  assert.deepEqual(original.summary, { purchases: "4480.00", refunds: "1200.00", net: "3280.00", still_due: "2100.00" });
  rows.find(row => row.id === "d9").refund_for = "d3";
  const linked = report({ id: 1 }, parseTransactions(toCsv(rows)));
  assert.equal(linked.summary.still_due, "1800.00");
  assert.equal(linked.summary.net, original.summary.net);
  assert.equal(linked.watchlist.find(item => item.id === "d3").status, "Received");
  assert.equal(categories(rows).Transport, "680.00");
});

test("CSV preserves quoted commas, rejects bad refund links, and rejects duplicate ids", () => {
  const rows = parseTransactions(demoCsv);
  rows[0].description = 'Cafe, "North"';
  assert.equal(parseTransactions(toCsv(rows))[0].description, rows[0].description);
  rows[0].id = rows[1].id;
  assert.throws(() => parseTransactions(toCsv(rows)), /unique id/);
  rows[0].id = "d1";
  rows.find(row => row.id === "d9").refund_for = "missing";
  assert.throws(() => parseTransactions(toCsv(rows)), /existing purchase/);
});

test("statement conversion separates spending, refunds, and transfers", () => {
  const csv = `Transaction Date,Narration,Withdrawal,Deposit\n14/10/2026,UPI CANTEEN,"1,250.00",\n15/10/2026,BOOKSTORE REFUND,,300.00\n15/10/2026,MONEY FROM HOME,,5000.00\n16/10/2026,CREDIT CARD BILL PAYMENT,800.00,\n`;
  const options = { mode: "split", date_format: "dmy_slash", account: "Campus bank", mapping: {
    date: "Transaction Date", description: "Narration", debit: "Withdrawal", credit: "Deposit" } };
  assert.equal(inspectStatement(csv).suggested.mode, "split");
  const converted = convertStatement(csv, options);
  assert.deepEqual(converted.counts, { purchase: 1, refund: 1, transfer: 2 });
  assert.equal(report({ id: 1 }, parseTransactions(converted.csv)).summary.net, "950.00");
});

test("comparison uses equal non-overlapping periods and saved categories", () => {
  const periods = { before: { dataset_id: 1, start: "2026-08-01", end: "2026-08-28" },
    after: { dataset_id: 1, start: "2026-09-01", end: "2026-09-28" } };
  const [before, after] = validatePeriods(periods);
  const rows = parseTransactions(demoCsv);
  const result = compare(rows, rows, before, after, { id: 1 }, { id: 1 });
  assert.equal(result.changes.purchases, "4480.00");
  assert.equal(result.after.summary.count, 8);
  assert.throws(() => validatePeriods({ ...periods, after: { ...periods.after, end: "2026-09-29" } }), /same number/);
});
