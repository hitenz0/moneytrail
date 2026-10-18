import { cents, csvRows, fail, FIELDS, isoDate, money, parseTransactions, toCsv } from "./core.js";

const HEADER_HINTS = {
  date: ["date", "transactiondate", "valuedate", "posteddate"],
  description: ["description", "narration", "details", "particulars", "merchant"],
  debit: ["debit", "withdrawal", "withdrawals", "paidout"],
  credit: ["credit", "deposit", "deposits", "paidin"],
  amount: ["amount", "transactionamount"],
};
const REFUND_WORDS = /\b(refund|reversal|reversed|cashback|chargeback)\b/i;
const TRANSFER_WORDS = /\b(credit\s*card\s*(bill|payment)|card\s*bill|cc\s*bill|self\s*transfer)\b/i;
const DATE_FORMATS = new Set(["iso", "dmy_slash", "dmy_dash", "mdy_slash"]);

function readStatement(text) {
  const all = csvRows(text);
  const headers = all[0]?.cells.map(cell => cell.trim());
  if (!headers || !headers.length || headers.length > 50 || headers.some(cell => !cell)) fail("Statement needs a header row with 1 to 50 named columns");
  if (new Set(headers).size !== headers.length) fail("Statement column names must be unique");
  const rows = [];
  for (const item of all.slice(1)) {
    if (item.cells.every(cell => !cell.trim())) continue;
    if (item.cells.length !== headers.length) fail(`Line ${item.line}: expected ${headers.length} columns, found ${item.cells.length}`);
    rows.push({ line: item.line, row: Object.fromEntries(headers.map((header, i) => [header, item.cells[i]])) });
    if (rows.length > 10000) fail("Import at most 10,000 transactions");
  }
  if (!rows.length) fail("Statement has no transactions");
  return [headers, rows];
}

export function inspectStatement(text) {
  const [headers, rows] = readStatement(text);
  const suggested = {};
  for (const [field, hints] of Object.entries(HEADER_HINTS))
    suggested[field] = headers.find(header => hints.includes(header.toLowerCase().replace(/[^a-z0-9]/g, ""))) || "";
  const firstDate = rows[0].row[suggested.date] || "";
  suggested.date_format = firstDate.includes("/") ? "dmy_slash" : /^\d{2}-\d{2}-\d{4}$/.test(firstDate.trim()) ? "dmy_dash" : "iso";
  suggested.mode = suggested.debit && suggested.credit ? "split" : "signed";
  return { headers, count: rows.length, sample: rows.slice(0, 3).map(item => item.row), suggested };
}

function statementDate(value, format, line) {
  const text = value.trim();
  if (format === "iso") { try { return isoDate(text); } catch { fail(`Line ${line}: date does not match the selected format`); } }
  const separator = format === "dmy_dash" ? "-" : "/";
  const pieces = text.split(separator);
  if (pieces.length !== 3 || pieces[0].length !== 2 || pieces[1].length !== 2 || pieces[2].length !== 4 || pieces.some(x => !/^\d+$/.test(x)))
    fail(`Line ${line}: date does not match the selected format`);
  const [left, middle, year] = pieces;
  const month = format === "mdy_slash" ? left : middle;
  const day = format === "mdy_slash" ? middle : left;
  try { return isoDate(`${year}-${month}-${day}`); }
  catch { fail(`Line ${line}: date does not match the selected format`); }
}

function amountValue(raw, line) {
  let value = raw.trim().replace(/,/g, "").replace(/₹/g, "").replace(/^INR\s*/i, "").trim();
  if (value.startsWith("(") && value.endsWith(")")) value = "-" + value.slice(1, -1);
  try { return cents(value); }
  catch { fail(`Line ${line}: invalid amount ${JSON.stringify(raw)}`); }
}

export function convertStatement(text, options) {
  const [headers, sourceRows] = readStatement(text);
  if (!options || typeof options !== "object") fail("Choose the statement columns");
  const { mapping, mode, date_format: dateFormat, account } = options;
  if (!mapping || typeof mapping !== "object" || !["split", "signed"].includes(mode) || !DATE_FORMATS.has(dateFormat)) fail("Choose a date format and amount columns");
  if (typeof account !== "string" || !account.trim() || account.trim().length > 100) fail("Enter an account name of 1 to 100 characters");
  const required = mode === "split" ? ["date", "description", "debit", "credit"] : ["date", "description", "amount"];
  const chosen = required.map(field => mapping[field]);
  if (chosen.some(name => typeof name !== "string" || !headers.includes(name)) || new Set(chosen).size !== chosen.length)
    fail("Map each required field to a different statement column");
  const sample = [], counts = { purchase: 0, refund: 0, transfer: 0 }, converted = [];
  for (const [index, item] of sourceRows.entries()) {
    const row = item.row, line = item.line;
    const date = statementDate(row[mapping.date], dateFormat, line);
    const description = row[mapping.description].trim();
    if (!description) fail(`Line ${line}: description is blank`);
    let amount;
    if (mode === "signed") amount = amountValue(row[mapping.amount], line);
    else {
      const debitRaw = row[mapping.debit].trim(), creditRaw = row[mapping.credit].trim();
      const debit = debitRaw ? amountValue(debitRaw, line) : 0;
      const credit = creditRaw ? amountValue(creditRaw, line) : 0;
      if (debit < 0 || credit < 0 || Boolean(debit) === Boolean(credit)) fail(`Line ${line}: enter a positive debit or credit, but not both`);
      amount = credit - debit;
    }
    if (!amount) fail(`Line ${line}: amount cannot be zero`);
    const kind = amount > 0 ? REFUND_WORDS.test(description) ? "refund" : "transfer" : TRANSFER_WORDS.test(description) ? "transfer" : "purchase";
    const entry = { id: `statement-${index + 1}`, date, description, amount: money(amount), account: account.trim(), kind,
      category: "", refund_expected: "", refund_for: "" };
    converted.push(entry); counts[kind]++;
    if (sample.length < 8) sample.push(entry);
  }
  const csv = toCsv(converted, FIELDS);
  parseTransactions(csv);
  return { csv, sample, counts, count: sourceRows.length };
}
