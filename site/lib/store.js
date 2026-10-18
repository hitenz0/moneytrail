import { fail, FIELDS, FOLLOWUP_FIELDS, parseTransactions, report, toCsv } from "./core.js";
import { compare, validatePeriods } from "./comparison.js";

function sha256(text) {
  return crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)).then(buffer =>
    [...new Uint8Array(buffer)].map(byte => byte.toString(16).padStart(2, "0")).join(""));
}

export async function datasets(db, userId) {
  const result = await db.prepare("SELECT d.id,d.name,d.version,d.created_at,MIN(t.date) AS first_date,MAX(t.date) AS last_date FROM datasets d LEFT JOIN transactions t ON t.dataset_id=d.id WHERE d.user_id=? AND d.status='ready' GROUP BY d.id ORDER BY d.id DESC")
    .bind(userId).all();
  return result.results || [];
}

export async function rows(db, datasetId) {
  const result = await db.prepare("SELECT id,date,description,amount,account,kind,category,refund_expected,refund_for,refund_due,refund_note FROM transactions WHERE dataset_id=? ORDER BY date,rowid")
    .bind(datasetId).all();
  return result.results || [];
}

export async function state(db, userId, selected) {
  const list = await datasets(db, userId);
  if (!list.length) return { datasets: [], report: null };
  const id = selected === null || selected === undefined ? list[0].id : selected;
  const dataset = list.find(item => item.id === id);
  if (!dataset) fail("That import no longer exists");
  return { datasets: list, report: report(dataset, await rows(db, id)) };
}

export async function importCsv(db, userId, name, text) {
  if (typeof name !== "string" || !name.trim() || name.length > 200) fail("Give this import a name of 1 to 200 characters");
  const parsed = parseTransactions(text);
  if (!parsed.length || parsed.length > 10000) fail("Import between 1 and 10,000 transactions");
  const fingerprintFields = parsed.some(row => FOLLOWUP_FIELDS.some(field => row[field])) ? [...FIELDS, ...FOLLOWUP_FIELDS] : FIELDS;
  const fingerprint = await sha256(toCsv(parsed, fingerprintFields));
  const existing = await db.prepare("SELECT id,status FROM datasets WHERE user_id=? AND fingerprint=?").bind(userId, fingerprint).first();
  if (existing) {
    if (existing.status !== "ready") fail("This import is still processing. Try again shortly.", 409);
    return [existing.id, true];
  }
  let datasetId;
  try {
    const inserted = await db.prepare("INSERT INTO datasets (user_id,name,fingerprint,status) VALUES (?,?,?,'loading')")
      .bind(userId, name.trim(), fingerprint).run();
    datasetId = inserted.meta.last_row_id;
    const fields = [...FIELDS, ...FOLLOWUP_FIELDS];
    const sql = `INSERT INTO transactions (dataset_id,${fields.join(",")}) VALUES (${Array(12).fill("?").join(",")})`;
    for (let start = 0; start < parsed.length; start += 50) {
      const chunk = parsed.slice(start, start + 50);
      await db.batch(chunk.map(row => db.prepare(sql).bind(datasetId, ...fields.map(field => row[field]))));
    }
    await db.prepare("UPDATE datasets SET status='ready' WHERE id=? AND user_id=?").bind(datasetId, userId).run();
    return [datasetId, false];
  } catch (error) {
    if (datasetId) {
      await db.prepare("DELETE FROM transactions WHERE dataset_id=?").bind(datasetId).run();
      await db.prepare("DELETE FROM datasets WHERE id=? AND user_id=?").bind(datasetId, userId).run();
    }
    const race = await db.prepare("SELECT id,status FROM datasets WHERE user_id=? AND fingerprint=?").bind(userId, fingerprint).first();
    if (race?.status === "ready") return [race.id, true];
    throw error;
  }
}

export async function updateTransaction(db, userId, data) {
  const datasetId = data?.dataset_id, id = data?.id, version = data?.version, changes = data?.changes;
  if (!Number.isInteger(datasetId) || !Number.isInteger(version) || typeof id !== "string") fail("Choose a transaction from the current import");
  const allowedFields = new Set(["kind", "category", "refund_expected", "refund_for", ...FOLLOWUP_FIELDS]);
  if (!changes || typeof changes !== "object" || !Object.keys(changes).length || Object.keys(changes).some(key => !allowedFields.has(key)))
    fail("Only transaction type, category, and refund details can be edited");
  if (Object.values(changes).some(value => typeof value !== "string" || value.length > 200)) fail("Edits must be text of at most 200 characters");
  const dataset = await db.prepare("SELECT version FROM datasets WHERE id=? AND user_id=? AND status='ready'").bind(datasetId, userId).first();
  if (!dataset) fail("That import no longer exists");
  if (dataset.version !== version) fail("This import changed in another tab. Reload it before saving again.", 409);
  const all = await rows(db, datasetId);
  const row = all.find(item => item.id === id);
  if (!row) fail("Transaction not found");
  const kind = changes.kind || row.kind;
  if (!["purchase", "refund", "transfer"].includes(kind)) fail("Choose purchase, refund, or transfer");
  const permitted = new Set(["kind", ...(kind === "purchase" ? ["category", "refund_expected", ...FOLLOWUP_FIELDS] : kind === "refund" ? ["refund_for"] : [])]);
  if (Object.keys(changes).some(key => !permitted.has(key))) fail("That field does not apply to this transaction");
  if (kind !== row.kind) {
    if (kind !== "purchase") Object.assign(row, { category: "", refund_expected: "0.00", refund_due: "", refund_note: "" });
    if (kind !== "refund") row.refund_for = "";
  }
  Object.assign(row, changes);
  const checked = parseTransactions(toCsv(all)).find(item => item.id === id);
  const results = await db.batch([
    db.prepare("UPDATE transactions SET kind=?,category=?,refund_expected=?,refund_for=?,refund_due=?,refund_note=? WHERE dataset_id=? AND id=? AND EXISTS (SELECT 1 FROM datasets WHERE id=? AND user_id=? AND version=?)")
      .bind(checked.kind, checked.category, checked.refund_expected, checked.refund_for, checked.refund_due, checked.refund_note, datasetId, id, datasetId, userId, version),
    db.prepare("UPDATE datasets SET version=version+1 WHERE id=? AND user_id=? AND version=?").bind(datasetId, userId, version),
  ]);
  if (!results[0].meta.changes || !results[1].meta.changes) fail("This import changed in another tab. Reload it before saving again.", 409);
}

export async function comparison(db, userId, data) {
  const [before, after] = validatePeriods(data);
  const list = await datasets(db, userId);
  const left = list.find(item => item.id === before.dataset_id), right = list.find(item => item.id === after.dataset_id);
  if (!left || !right) fail("That import no longer exists");
  const beforeRows = await rows(db, left.id), afterRows = left.id === right.id ? beforeRows : await rows(db, right.id);
  return compare(beforeRows, afterRows, before, after, left, right);
}
