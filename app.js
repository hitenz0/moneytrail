const $ = (id) => document.getElementById(id);
const currency = new Intl.NumberFormat("en-IN", {style: "currency", currency: "INR"});
const money = (value) => currency.format(Number(value));
let state = {datasets: [], report: null};
let editing = null;
let busy = false;
let watchlistDay = "";

function element(tag, text, className) {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    if (className) node.className = className;
    return node;
}

function button(text, action, className = "secondary compact") {
    const node = element("button", text, className);
    node.type = "button";
    node.addEventListener("click", action);
    return node;
}

function notice(message, error = false) {
    $("notice").textContent = message;
    $("notice").className = error ? "error" : "";
    $("notice").setAttribute("role", error ? "alert" : "status");
    $("notice").hidden = !message;
}

async function request(path, body) {
    let response;
    try {
        response = await fetch(path, body === undefined ? {} : {
            method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify(body)
        });
    } catch {
        throw new Error("Cannot reach MoneyTrail. Start python app.py and reload this page.");
    }
    let data;
    try { data = await response.json(); }
    catch { throw new Error("Start python app.py, then open the address it prints to use this page."); }
    if (!response.ok) throw new Error(data.error || "Something went wrong. Please try again.");
    return data;
}

async function action(work) {
    if (busy) return;
    busy = true;
    document.querySelectorAll("button:not([data-theme-choice]), input, select, textarea").forEach((node) => node.disabled = true);
    try { await work(); }
    catch (error) { notice(error.message, true); }
    finally {
        busy = false;
        document.querySelectorAll("button:not([data-theme-choice]), input, select, textarea").forEach((node) => node.disabled = false);
    }
}

function useState(data) {
    state = data;
    try { localStorage.setItem("moneytrail-dataset", state.report?.dataset.id || ""); } catch {}
    render();
}

async function save(row, changes) {
    const data = await request("/api/transaction", {
        dataset_id: state.report.dataset.id, version: state.report.dataset.version, id: row.id, changes
    });
    useState(data);
    notice("Changes saved on this computer.");
}

function render() {
    const report = state.report;
    $("dataset").replaceChildren();
    if (!state.datasets.length) $("dataset").append(new Option("No imports yet", ""));
    state.datasets.forEach((item) => $("dataset").append(new Option(item.name, item.id)));
    $("dataset").value = report?.dataset.id || "";
    $("empty").hidden = Boolean(report);
    $("dashboard").hidden = !report;
    if (!report) return;
    $("dataset-name").textContent = report.dataset.name;
    const dates = report.transactions.map((row) => row.date).sort();
    $("dataset-meta").textContent = dates[0] + " to " + dates.at(-1) + " · " + report.transactions.length + " transactions · Saved on this computer";
    $("export").href = "/api/export?dataset=" + report.dataset.id;
    for (const key of ["purchases", "refunds", "net"]) $(key).textContent = money(report.summary[key]);
    $("still-due").textContent = money(report.summary.still_due);
    renderCategories();
    renderWatchlist();
    renderReview();
    renderTransactions();
}

function renderCategories() {
    $("categories").replaceChildren();
    const entries = Object.entries(state.report.categories).sort((a, b) => Number(b[1]) - Number(a[1]));
    if (!entries.length) $("categories").append(element("p", "No purchases in this import.", "note"));
    entries.forEach(([name, amount]) => {
        const row = element("div", undefined, "category-row");
        const label = element("div", undefined, "category-label");
        label.append(element("span", name), element("strong", money(amount)));
        const track = element("div", undefined, "track");
        const fill = element("div", undefined, "fill");
        fill.style.width = Number(amount) / Number(state.report.summary.purchases) * 100 + "%";
        track.append(fill);
        row.append(label, track);
        $("categories").append(row);
    });
}

function refundTiming(item, now = new Date()) {
    if (!item.refund_due) return {overdue: false, label: "No expected date set"};
    // Compare calendar days in the browser's timezone, without DST-length days.
    const today = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
    const due = new Date(item.refund_due + "T00:00:00Z");
    const days = Math.round((today - due.getTime()) / 86400000);
    const expected = "Expected " + new Intl.DateTimeFormat("en-IN", {day: "numeric", month: "short", year: "numeric", timeZone: "UTC"}).format(due);
    const overdue = Number(item.remaining) > 0 && days > 0;
    const suffix = overdue ? " · " + days + (days === 1 ? " day overdue" : " days overdue") :
        Number(item.remaining) > 0 && days === 0 ? " · Due today" : "";
    return {overdue, label: expected + suffix};
}

function renderWatchlist() {
    watchlistDay = new Date().toDateString();
    const items = state.report.watchlist;
    const overdueCount = items.filter((item) => refundTiming(item).overdue).length;
    $("watch-count").textContent = items.filter((item) => Number(item.remaining) > 0).length + " OPEN · " + overdueCount + " OVERDUE";
    $("watchlist").replaceChildren();
    const overdueOnly = $("watch-filter").value === "overdue";
    const visible = overdueOnly ? items.filter((item) => refundTiming(item).overdue) : items;
    if (!visible.length) $("watchlist").append(element("p", overdueOnly ? "No overdue refunds. Choose All tracked refunds to see the full watchlist." : "Expecting a refund? Edit a purchase below and enter how much you expect back.", "note"));
    visible.forEach((item) => {
        const block = element("div", undefined, "watch-item");
        const heading = element("div", undefined, "watch-heading");
        heading.append(element("strong", item.description), element("span", item.status, "status " + (item.status === "Received" ? "received" : "")));
        const amounts = element("div", undefined, "watch-amounts");
        amounts.append(element("span", money(item.received) + " of " + money(item.expected) + " linked"), element("strong", money(item.remaining) + " due"));
        const track = element("div", undefined, "track");
        const fill = element("div", undefined, "fill");
        fill.style.width = Math.min(100, Number(item.received) / Number(item.expected) * 100) + "%";
        track.append(fill);
        const actions = element("div", undefined, "watch-actions");
        actions.append(button("Edit refund details", () => openEdit(item.id)));
        const timing = refundTiming(item);
        const expected = element("p", timing.label, timing.overdue ? "refund-timing overdue" : "refund-timing note");
        block.append(heading, expected, amounts, track);
        if (item.refund_note) block.append(element("p", item.refund_note, "refund-note note small"));
        block.append(actions);
        $("watchlist").append(block);
    });
}

function renderReview() {
    const rows = state.report.transactions;
    const unlinked = rows.filter((row) => row.kind === "refund" && !row.refund_for);
    $("review-count").textContent = unlinked.length + " UNLINKED";
    $("refund-review").replaceChildren();
    if (!unlinked.length) $("refund-review").append(element("p", "No refunds need linking in this import.", "note"));
    unlinked.forEach((row) => {
        const block = element("div", undefined, "review-item");
        const info = element("div");
        info.append(element("strong", row.description + " · " + money(row.amount)), element("p", row.date + " · " + row.account + " · " + row.id, "note small"));
        const options = element("div", undefined, "review-options");
        const suggestions = state.report.refund_suggestions.filter((item) => item.refund_id === row.id);
        suggestions.forEach((item) => {
            const purchase = rows.find((row) => row.id === item.purchase_id);
            const choice = element("div", undefined, "review-option");
            choice.append(button("Confirm link to " + purchase.description + " (" + purchase.id + ")", () => action(() => save(row, {refund_for: purchase.id})), "compact"));
            choice.append(element("p", "Shared word: " + item.shared_words.join(", ") + " · date and amount fit", "note"));
            options.append(choice);
        });
        if (!suggestions.length) options.append(element("p", "No suggested purchase. Choose one if you recognize this refund.", "note small"));
        options.append(button("Choose a purchase", () => openEdit(row.id)));
        block.append(info, options);
        $("refund-review").append(block);
    });
}

function renderTransactions() {
    if (!state.report) return;
    const search = $("search").value.toLowerCase().trim();
    const kind = $("kind").value;
    const rows = state.report.transactions.filter((row) => (!kind || row.kind === kind) &&
        [row.id, row.description, row.account, row.category || "Uncategorized"].join(" ").toLowerCase().includes(search));
    rows.sort((a, b) => b.date.localeCompare(a.date));
    $("transaction-count").textContent = "Showing " + rows.length + " of " + state.report.transactions.length;
    $("transactions").replaceChildren();
    if (!rows.length) {
        const row = element("tr");
        const cell = element("td", "No matching transactions. Try a different search or transaction type.", "note");
        cell.colSpan = 6;
        row.append(cell);
        $("transactions").append(row);
    }
    rows.forEach((row) => {
        const tr = element("tr");
        const date = element("td", row.date);
        date.append(element("span", row.id, "note"));
        const description = element("td", row.description);
        description.append(element("span", row.kind, "note"));
        const category = element("td");
        if (row.kind === "purchase") {
            category.append(element("span", row.category || "Uncategorized"));
            const guesses = state.report.category_suggestions;
            const guess = Object.hasOwn(guesses, row.id) ? guesses[row.id] : null;
            if (guess) category.append(document.createElement("br"), button("Use " + guess, () => action(() => save(row, {category: guess}))));
        } else if (row.kind === "refund") {
            category.append(element("span", row.refund_for ? "Linked to " + row.refund_for : "Unlinked"));
        } else category.append(element("span", "Excluded from spending", "note"));
        const amount = element("td", (Number(row.amount) > 0 ? "+" : "") + money(row.amount), "amount " + (row.kind === "refund" ? "credit" : ""));
        const actions = element("td");
        if (row.kind !== "transfer") actions.append(button("Edit", () => openEdit(row.id)));
        tr.append(date, description, element("td", row.account), category, amount, actions);
        $("transactions").append(tr);
    });
}

function openEdit(id) {
    editing = state.report.transactions.find((row) => row.id === id);
    $("edit-title").textContent = editing.kind === "purchase" ? "Edit purchase" : "Review refund link";
    $("edit-description").textContent = editing.description;
    $("edit-details").textContent = editing.date + " · " + editing.account + " · " + money(editing.amount) + " · " + editing.id;
    const purchase = editing.kind === "purchase";
    $("purchase-fields").hidden = !purchase;
    $("followup-fields").hidden = !purchase;
    $("refund-fields").hidden = purchase;
    $("edit-expected").required = purchase;
    $("edit-expected").max = purchase ? String(-Number(editing.amount)) : "999999999.99";
    $("edit-expected").value = purchase ? editing.refund_expected : "0";
    $("edit-category").value = editing.category;
    $("edit-due").min = purchase ? editing.date : "";
    $("edit-due").value = purchase ? editing.refund_due || "" : "";
    $("edit-note").value = purchase ? editing.refund_note || "" : "";
    $("edit-link").replaceChildren(new Option("Unlinked", ""));
    state.report.transactions.filter((row) => row.kind === "purchase" && row.date <= editing.date).forEach((row) => {
        $("edit-link").append(new Option(row.description + " · " + row.date + " · " + money(-Number(row.amount)) + " (" + row.id + ")", row.id));
    });
    $("edit-link").value = editing.refund_for;
    $("edit-error").hidden = true;
    $("edit-dialog").showModal();
}

$("edit-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const changes = editing.kind === "purchase" ? {category: $("edit-category").value.trim(), refund_expected: $("edit-expected").value, refund_due: $("edit-due").value, refund_note: $("edit-note").value.trim()} : {refund_for: $("edit-link").value};
    action(async () => {
        try {
            await save(editing, changes);
            $("edit-dialog").close();
        } catch (error) {
            $("edit-error").textContent = error.message;
            $("edit-error").hidden = false;
        }
    });
});
$("close-dialog").addEventListener("click", () => $("edit-dialog").close());
$("cancel-dialog").addEventListener("click", () => $("edit-dialog").close());
$("search").addEventListener("input", renderTransactions);
$("kind").addEventListener("change", renderTransactions);
$("watch-filter").addEventListener("change", renderWatchlist);
// Refresh overnight without rebuilding focused controls every minute.
function refreshWatchlistDate() {
    if (state.report && !document.hidden && watchlistDay !== new Date().toDateString()) renderWatchlist();
}
setInterval(refreshWatchlistDate, 60000);
document.addEventListener("visibilitychange", refreshWatchlistDate);
$("dataset").addEventListener("change", () => action(async () => {
    if (!$("dataset").value) return;
    useState(await request("/api/state?dataset=" + $("dataset").value));
    notice("");
}));
$("demo").addEventListener("click", () => action(async () => {
    useState(await request("/api/demo", {}));
    notice("Student demo opened. Explore the refund links and purchase categories below.");
}));
$("import").addEventListener("click", () => $("file").click());
$("file").addEventListener("change", () => {
    const file = $("file").files[0];
    if (!file) return;
    action(async () => {
        try {
            if (file.size > 2 * 1024 * 1024) throw new Error("Choose a CSV smaller than 2 MB.");
            const csv = new TextDecoder("utf-8", {fatal: true}).decode(await file.arrayBuffer());
            const data = await request("/api/import", {name: file.name, csv});
            useState(data);
            notice(data.duplicate ? "Opened the saved copy of this import. Your edits are still here." : "CSV imported and saved. Review your spending below.");
        } finally { $("file").value = ""; }
    });
});

action(async () => {
    let selected = "";
    try { selected = localStorage.getItem("moneytrail-dataset") || ""; } catch {}
    let data;
    try { data = await request(selected ? "/api/state?dataset=" + encodeURIComponent(selected) : "/api/state"); }
    catch (error) {
        if (!selected) throw error;
        data = await request("/api/state");
    }
    useState(data);
});
