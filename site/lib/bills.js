import { cents, daysBetween, fail, isoDate, money } from "./core.js";

const CADENCES = new Set(["once", "weekly", "monthly", "quarterly", "yearly"]);
const PAYMENT_METHODS = new Set(["manual", "autopay"]);

function billDate(value) {
  try { return isoDate(value, "bill date"); }
  catch { fail("Choose a valid bill date"); }
}

function nextBillDate(row) {
  if (row.cadence === "weekly") {
    const date = new Date(`${row.next_due}T00:00:00Z`);
    date.setUTCDate(date.getUTCDate() + 7);
    return date.toISOString().slice(0, 10);
  }
  const months = { monthly: 1, quarterly: 3, yearly: 12 }[row.cadence];
  const [year, month] = row.next_due.split("-").map(Number);
  const target = new Date(Date.UTC(year, month - 1 + months, 1));
  const last = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(row.anchor_day, last));
  return target.toISOString().slice(0, 10);
}

export async function billReport(db, userId, today) {
  billDate(today);
  const result = await db.prepare("SELECT id, name, amount, cadence, next_due, note, payment_method, status, anchor_day, anchor_month, version, last_paid_due, last_paid_on FROM bills WHERE user_id=? ORDER BY next_due, id").bind(userId).all();
  const rows = result.results || [];
  let monthly = 0, nextSeven = 0, overdue = 0, activeCount = 0, overdueCount = 0;
  for (const row of rows) {
    row.days_until = daysBetween(today, row.next_due);
    if (row.status !== "active") continue;
    activeCount++;
    const amount = cents(row.amount);
    if (row.cadence === "weekly") monthly += amount * 52 / 12;
    else if (row.cadence === "monthly") monthly += amount;
    else if (row.cadence === "quarterly") monthly += amount / 3;
    else if (row.cadence === "yearly") monthly += amount / 12;
    if (row.days_until >= 0 && row.days_until < 7) nextSeven += amount;
    else if (row.days_until < 0) { overdue += amount; overdueCount++; }
  }
  return { today, items: rows, summary: { monthly: money(Math.round(monthly)), next_seven: money(nextSeven), overdue: money(overdue),
    active_count: activeCount, overdue_count: overdueCount } };
}

export async function saveBill(db, userId, data, today) {
  billDate(today);
  const action = data?.action;
  if (!["save", "pay", "undo", "pause", "resume"].includes(action)) fail("Choose a valid bill action");
  let row = null;
  if (data.id !== undefined && data.id !== null) {
    if (!Number.isInteger(data.id) || !Number.isInteger(data.version)) fail("Choose a saved bill");
    row = await db.prepare("SELECT * FROM bills WHERE user_id=? AND id=?").bind(userId, data.id).first();
    if (!row) fail("That bill no longer exists");
    if (row.version !== data.version) fail("This bill changed in another tab. Reload the page before saving again.", 409);
  } else if (action !== "save") fail("Choose a saved bill");

  if (action === "save") {
    const fields = data.fields;
    const names = ["name", "amount", "cadence", "next_due", "note", "payment_method"];
    if (!fields || typeof fields !== "object" || Object.keys(fields).sort().join() !== [...names].sort().join())
      fail("Enter the bill name, amount, frequency, next date, payment method, and optional note");
    if (names.some(name => typeof fields[name] !== "string" || fields[name].length > 200)) fail("Bill details must be text of at most 200 characters");
    const name = fields.name.trim(), note = fields.note.trim(), due = billDate(fields.next_due);
    if (!name || name.length > 100) fail("Give the bill a name of 1 to 100 characters");
    if (!CADENCES.has(fields.cadence)) fail("Choose one-time, weekly, monthly, quarterly, or yearly");
    if (!PAYMENT_METHODS.has(fields.payment_method)) fail("Choose manual payment or autopay");
    let amount;
    try { amount = cents(fields.amount); } catch { fail("Enter a valid bill amount"); }
    if (amount <= 0) fail("Enter a positive amount below one billion INR with at most two decimal places");
    if (!row) await db.prepare("INSERT INTO bills (user_id,name,amount,cadence,next_due,note,payment_method,anchor_day,anchor_month) VALUES (?,?,?,?,?,?,?,?,?)")
      .bind(userId, name, money(amount), fields.cadence, due, note, fields.payment_method, Number(due.slice(8)), Number(due.slice(5, 7))).run();
    else {
      const changed = due !== row.next_due || fields.cadence !== row.cadence;
      const status = changed && row.status === "paid" ? "active" : row.status;
      const result = await db.prepare("UPDATE bills SET name=?,amount=?,cadence=?,next_due=?,note=?,payment_method=?,anchor_day=?,anchor_month=?,status=?,last_paid_due=?,last_paid_on=?,version=version+1 WHERE user_id=? AND id=? AND version=?")
        .bind(name, money(amount), fields.cadence, due, note, fields.payment_method,
          changed ? Number(due.slice(8)) : row.anchor_day, changed ? Number(due.slice(5, 7)) : row.anchor_month,
          status, changed ? "" : row.last_paid_due, changed ? "" : row.last_paid_on, userId, row.id, row.version).run();
      if (!result.meta.changes) fail("This bill changed in another tab. Reload the page before saving again.", 409);
    }
    return;
  }

  let sql, args;
  if (action === "pay") {
    if (row.status !== "active") fail("Only active bills can be marked paid");
    sql = "UPDATE bills SET next_due=?,status=?,last_paid_due=?,last_paid_on=?,version=version+1 WHERE user_id=? AND id=? AND version=?";
    args = [row.cadence === "once" ? row.next_due : nextBillDate(row), row.cadence === "once" ? "paid" : "active", row.next_due, today];
  } else if (action === "undo") {
    if (!row.last_paid_due) fail("There is no recent payment to undo");
    sql = "UPDATE bills SET next_due=?,status=?,last_paid_due='',last_paid_on='',version=version+1 WHERE user_id=? AND id=? AND version=?";
    args = [row.last_paid_due, row.status === "paused" ? "paused" : "active"];
  } else {
    if (row.status !== (action === "pause" ? "active" : "paused")) fail("Reload the page to see this bill's current status");
    sql = "UPDATE bills SET status=?,version=version+1 WHERE user_id=? AND id=? AND version=?";
    args = [action === "pause" ? "paused" : "active"];
  }
  const result = await db.prepare(sql).bind(...args, userId, row.id, row.version).run();
  if (!result.meta.changes) fail("This bill changed in another tab. Reload the page before saving again.", 409);
}
