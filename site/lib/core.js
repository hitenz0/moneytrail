export const FIELDS = ["id", "date", "description", "amount", "account", "kind", "category", "refund_expected", "refund_for"];
export const FOLLOWUP_FIELDS = ["refund_due", "refund_note"];
const MAX_CENTS = 99999999999;
const COMMON_WORDS = new Set(["card", "credit", "online", "partial", "payment", "refund", "return", "upi"]);
const CATEGORY_WORDS = {
  Food: new Set(["cafe", "canteen", "swiggy", "zomato"]),
  Transport: new Set(["bus", "metro", "ola", "uber"]),
  Shopping: new Set(["amazon", "bookstore", "flipkart"]),
};

export function fail(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  throw error;
}

export function cents(value, label = "amount") {
  const text = String(value ?? "").trim();
  if (!/^[+-]?\d+(?:\.\d{1,2})?$/.test(text)) fail(`${label} must be a number with at most two decimal places`);
  const negative = text.startsWith("-");
  const digits = text.replace(/^[+-]/, "").split(".");
  const result = Number(digits[0]) * 100 + Number((digits[1] || "").padEnd(2, "0"));
  if (!Number.isSafeInteger(result) || result > MAX_CENTS) fail(`${label} must be below one billion INR`);
  return negative ? -result : result;
}

export function money(value) {
  const sign = value < 0 ? "-" : "";
  const abs = Math.abs(value);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

export function isoDate(value, label = "date") {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) fail(`Choose a valid ${label} in YYYY-MM-DD format`);
  const date = new Date(`${value}T00:00:00Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) fail(`Choose a valid ${label}`);
  return value;
}

export function daysBetween(a, b) {
  return (Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000;
}

export function csvRows(text) {
  if (typeof text !== "string" || new TextEncoder().encode(text).length > 2 * 1024 * 1024) fail("Choose a UTF-8 CSV smaller than 2 MB");
  const rows = [];
  let row = [], field = "", quoted = false, closed = false, line = 1, rowLine = 1;
  text = text.replace(/^\uFEFF/, "");
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (char === '"') { quoted = false; closed = true; }
      else { field += char; if (char === "\n") line++; }
    } else if (char === '"' && field === "" && !closed) {
      quoted = true;
    } else if (char === "," || char === "\n" || char === "\r") {
      row.push(field); field = ""; closed = false;
      if (char !== ",") {
        rows.push({ line: rowLine, cells: row }); row = [];
        if (char === "\r" && text[i + 1] === "\n") i++;
        line++; rowLine = line;
      }
    } else if (closed || char === '"') {
      fail(`Line ${line}: invalid CSV quoting`);
    } else field += char;
  }
  if (quoted) fail(`Line ${rowLine}: unterminated CSV quote`);
  if (field || row.length) { row.push(field); rows.push({ line: rowLine, cells: row }); }
  return rows;
}

export function toCsv(rows, fields = [...FIELDS, ...FOLLOWUP_FIELDS]) {
  const cell = value => {
    const text = String(value ?? "");
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  return [fields.join(","), ...rows.map(row => fields.map(field => cell(row[field])).join(","))].join("\r\n") + "\r\n";
}

export function parseTransactions(text) {
  const all = csvRows(text);
  if (!all.length) fail("CSV needs these columns: " + [...FIELDS].sort().join(", "));
  const headers = all[0].cells;
  if (!FIELDS.every(field => headers.includes(field))) fail("CSV needs these columns: " + [...FIELDS].sort().join(", "));
  if (new Set(headers).size !== headers.length) fail("CSV column names must be unique");
  const seen = new Set();
  const result = [];
  for (const item of all.slice(1)) {
    try {
      if (item.cells.length !== headers.length) fail("missing or extra CSV fields");
      const row = Object.fromEntries(headers.map((key, index) => [key, item.cells[index]]));
      const id = row.id.trim();
      if (!id || seen.has(id)) fail("each transaction needs a unique id");
      if (!row.description.trim() || !row.account.trim()) fail("description and account cannot be blank");
      const date = isoDate(row.date.trim());
      const amount = cents(row.amount, "amount");
      const kind = row.kind.trim().toLowerCase();
      if (!["purchase", "refund", "transfer"].includes(kind)) fail(`unknown kind: ${kind}`);
      if (kind === "purchase" && amount >= 0) fail("a purchase must have a negative amount");
      if (kind === "refund" && amount <= 0) fail("a refund must have a positive amount");
      const expected = cents(row.refund_expected?.trim() || "0", "expected refund");
      if (expected < 0) fail("expected refund must be a non-negative amount");
      if (expected > 0 && (kind !== "purchase" || expected > -amount)) fail("expected refund must belong to a purchase and cannot exceed its amount");
      const refundFor = row.refund_for.trim();
      if (refundFor && kind !== "refund") fail("only a refund can link to a purchase");
      const refundDue = (row.refund_due || "").trim();
      const refundNote = (row.refund_note || "").trim();
      if (refundDue) { isoDate(refundDue, "expected refund date"); if (refundDue < date) fail("expected refund date cannot be before the purchase"); }
      if (refundNote.length > 200) fail("refund note must be at most 200 characters");
      if ((refundDue || refundNote) && kind !== "purchase") fail("refund dates and notes belong to purchases only");
      seen.add(id);
      result.push({ id, date, description: row.description, amount: money(amount), account: row.account,
        kind, category: row.category.trim(), refund_expected: money(expected), refund_for: refundFor,
        refund_due: refundDue, refund_note: refundNote });
    } catch (error) { fail(`Line ${item.line}: ${error.message}`); }
  }
  const purchases = new Map(result.filter(row => row.kind === "purchase").map(row => [row.id, row]));
  for (const row of result) {
    if (!row.refund_for) continue;
    const purchase = purchases.get(row.refund_for);
    if (!purchase) fail(`Transaction ${row.id}: refund_for must point to an existing purchase id`);
    if (row.date < purchase.date) fail(`Transaction ${row.id}: a refund cannot link to a later purchase`);
  }
  return result;
}

export function summary(rows) {
  const purchases = rows.filter(row => row.kind === "purchase").reduce((sum, row) => sum - cents(row.amount), 0);
  const refunds = rows.filter(row => row.kind === "refund").reduce((sum, row) => sum + cents(row.amount), 0);
  return { purchases: money(purchases), refunds: money(refunds), net: money(purchases - refunds) };
}

export function categories(rows) {
  const totals = {};
  for (const row of rows) if (row.kind === "purchase") {
    const name = row.category || "Uncategorized";
    totals[name] = (totals[name] || 0) - cents(row.amount);
  }
  return Object.fromEntries(Object.entries(totals).map(([name, value]) => [name, money(value)]));
}

export function suggestCategory(description) {
  const words = new Set((description.toLowerCase().match(/[a-z0-9]+/g) || []));
  const matches = Object.entries(CATEGORY_WORDS).filter(([, terms]) => [...words].some(word => terms.has(word)));
  return matches.length === 1 ? matches[0][0] : null;
}

export function watchlist(rows) {
  const received = {};
  for (const row of rows) if (row.kind === "refund" && row.refund_for) received[row.refund_for] = (received[row.refund_for] || 0) + cents(row.amount);
  return rows.filter(row => row.kind === "purchase" && cents(row.refund_expected) > 0).map(row => {
    const got = received[row.id] || 0;
    const remaining = Math.max(0, cents(row.refund_expected) - got);
    return { id: row.id, description: row.description, expected: row.refund_expected, received: money(got),
      remaining: money(remaining), status: remaining === 0 ? "Received" : got > 0 ? "Partly received" : "Waiting",
      refund_due: row.refund_due || "", refund_note: row.refund_note || "" };
  });
}

function words(description) {
  return new Set((description.toLowerCase().match(/[a-z0-9]+/g) || []).filter(word => word.length >= 4 && !COMMON_WORDS.has(word)));
}

export function refundSuggestions(rows, list) {
  const purchases = new Map(rows.filter(row => row.kind === "purchase").map(row => [row.id, row]));
  const waiting = list.filter(item => cents(item.remaining) > 0);
  const byWord = new Map();
  const wordsByPurchase = waiting.map(item => words(purchases.get(item.id).description));
  wordsByPurchase.forEach((terms, index) => terms.forEach(word => {
    if (!byWord.has(word)) byWord.set(word, new Set());
    byWord.get(word).add(index);
  }));
  const suggestions = [];
  for (const refund of rows) if (refund.kind === "refund" && !refund.refund_for) {
    const refundWords = words(refund.description);
    const candidates = new Set([...refundWords].flatMap(word => [...(byWord.get(word) || [])]));
    for (const index of [...candidates].sort((a, b) => a - b)) {
      const item = waiting[index], purchase = purchases.get(item.id);
      const shared = [...refundWords].filter(word => wordsByPurchase[index].has(word)).sort();
      if (refund.date >= purchase.date && cents(refund.amount) <= cents(item.remaining) && shared.length)
        suggestions.push({ refund_id: refund.id, purchase_id: purchase.id, amount: refund.amount, shared_words: shared });
    }
  }
  return suggestions;
}

export function report(dataset, rows) {
  const list = watchlist(rows), totals = summary(rows);
  totals.still_due = money(list.reduce((sum, item) => sum + cents(item.remaining), 0));
  return { dataset, transactions: rows, summary: totals, categories: categories(rows), watchlist: list,
    refund_suggestions: refundSuggestions(rows, list),
    category_suggestions: Object.fromEntries(rows.filter(row => row.kind === "purchase" && !row.category)
      .map(row => [row.id, suggestCategory(row.description)])) };
}
