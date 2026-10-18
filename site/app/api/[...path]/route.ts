// @ts-nocheck
import { env } from "cloudflare:workers";
import { getChatGPTUser } from "../../chatgpt-auth";
import { billReport, saveBill } from "../../../lib/bills.js";
import { isoDate, toCsv } from "../../../lib/core.js";
import { demoCsv } from "../../../lib/demo.js";
import { comparison, importCsv, state, updateTransaction } from "../../../lib/store.js";
import { convertStatement, inspectStatement } from "../../../lib/statement.js";

export const dynamic = "force-dynamic";
const MAX_BODY = 2 * 1024 * 1024 + 65536;

function errorResponse(error) {
  const status = Number.isInteger(error?.status) ? error.status : 500;
  if (status === 500) console.error("MoneyTrail API error", error);
  return Response.json({ error: status === 500 ? "Could not save or read MoneyTrail data. Please try again." : error.message },
    { status, headers: { "Cache-Control": "no-store" } });
}

async function context(request) {
  const user = await getChatGPTUser();
  if (!user) return { error: Response.json({ error: "Sign in to MoneyTrail first." }, { status: 401 }) };
  if (!env.DB) throw new Error("D1 database binding unavailable");
  return { db: env.DB, userId: user.userId };
}

function action(request) {
  return new URL(request.url).pathname.slice(5);
}

function selectedDataset(request) {
  const value = new URL(request.url).searchParams.get("dataset");
  if (value === null) return null;
  const selected = Number(value);
  if (!Number.isSafeInteger(selected) || selected < 1) throw Object.assign(new Error("Choose a saved import"), { status: 400 });
  return selected;
}

export async function GET(request: Request) {
  try {
    const access = await context(request);
    if (access.error) return access.error;
    const { db, userId } = access;
    const name = action(request);
    if (name === "state") return Response.json(await state(db, userId, selectedDataset(request)));
    if (name === "bills") {
      const today = new URL(request.url).searchParams.get("today") || new Date().toISOString().slice(0, 10);
      return Response.json(await billReport(db, userId, today));
    }
    if (name === "export") {
      const current = await state(db, userId, selectedDataset(request));
      if (!current.report) throw Object.assign(new Error("Import a CSV first"), { status: 400 });
      return new Response(toCsv(current.report.transactions), { headers: {
        "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": 'attachment; filename="moneytrail-reviewed.csv"',
        "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
    }
    return Response.json({ error: "Page not found" }, { status: 404 });
  } catch (error) { return errorResponse(error); }
}

export async function POST(request: Request) {
  try {
    const access = await context(request);
    if (access.error) return access.error;
    const { db, userId } = access;
    const origin = request.headers.get("Origin");
    if (origin && origin !== new URL(request.url).origin) return Response.json({ error: "Open MoneyTrail using its own address" }, { status: 403 });
    if (request.headers.get("Content-Type")?.split(";")[0] !== "application/json")
      return Response.json({ error: "Send JSON data" }, { status: 400 });
    const declared = Number(request.headers.get("Content-Length") || 0);
    if (declared > MAX_BODY) return Response.json({ error: "Choose a CSV smaller than 2 MB" }, { status: 413 });
    const raw = await request.text();
    if (new TextEncoder().encode(raw).length > MAX_BODY) return Response.json({ error: "Choose a CSV smaller than 2 MB" }, { status: 413 });
    let data;
    try { data = JSON.parse(raw); } catch { return Response.json({ error: "Send valid JSON data" }, { status: 400 }); }
    if (!data || typeof data !== "object" || Array.isArray(data)) return Response.json({ error: "Expected a JSON object" }, { status: 400 });
    const name = action(request);
    if (name === "compare") return Response.json(await comparison(db, userId, data));
    if (name === "import/inspect") return Response.json(inspectStatement(data.csv));
    if (name === "import/preview") {
      const { csv, ...preview } = convertStatement(data.csv, data.options);
      return Response.json(preview);
    }
    if (name === "bills") {
      const today = isoDate(data.today, "bill date");
      await saveBill(db, userId, data, today);
      return Response.json(await billReport(db, userId, today));
    }
    let id, duplicate = false;
    if (name === "import") [id, duplicate] = await importCsv(db, userId, data.name, data.csv);
    else if (name === "import/mapped") {
      const mapped = convertStatement(data.csv, data.options);
      [id, duplicate] = await importCsv(db, userId, data.name, mapped.csv);
    } else if (name === "demo") [id, duplicate] = await importCsv(db, userId, "Student demo", demoCsv);
    else if (name === "transaction") { await updateTransaction(db, userId, data); id = data.dataset_id; }
    else return Response.json({ error: "Action not found" }, { status: 404 });
    const current = await state(db, userId, id);
    return Response.json({ ...current, duplicate });
  } catch (error) { return errorResponse(error); }
}
