let statementText = "";
let statementName = "";
let statementRevision = 0;

function statementOptions() {
    return {
        account: $("statement-account").value.trim(),
        mode: $("statement-mode").value,
        date_format: $("statement-date-format").value,
        mapping: Object.fromEntries(["date", "description", "debit", "credit", "amount"]
            .map((field) => [field, $("statement-" + field).value]))
    };
}

function statementError(message = "") {
    $("statement-error").textContent = message;
    $("statement-error").hidden = !message;
}

function invalidateStatementPreview() {
    statementRevision++;
    $("statement-preview").hidden = true;
    $("statement-import").disabled = true;
    statementError();
    const split = $("statement-mode").value === "split";
    $("statement-debit-field").hidden = !split;
    $("statement-credit-field").hidden = !split;
    $("statement-amount-field").hidden = split;
}

function closeStatementMapper() {
    statementRevision++;
    statementText = "";
    statementName = "";
    $("statement-dialog").close();
}

async function openStatementMapper(name, csv) {
    const info = await request("/api/import/inspect", {csv});
    statementName = name;
    statementText = csv;
    $("statement-file").textContent = name + " · " + info.count + " transaction" + (info.count === 1 ? "" : "s");
    for (const field of ["date", "description", "debit", "credit", "amount"]) {
        const select = $("statement-" + field);
        select.replaceChildren(new Option("Choose column", ""), ...info.headers.map((header) => new Option(header, header)));
        select.value = info.suggested[field] || "";
    }
    $("statement-date-format").value = info.suggested.date_format;
    $("statement-mode").value = info.suggested.mode;
    $("statement-account").value = name.replace(/\.csv$/i, "").slice(0, 100);
    invalidateStatementPreview();
    $("statement-dialog").showModal();
}

function renderStatementPreview(preview) {
    const counts = preview.counts;
    $("statement-counts").textContent = `${preview.count} rows · ${counts.purchase} purchases · ${counts.refund} refunds · ${counts.transfer} transfers`;
    const rows = preview.sample.map((row) => {
        const item = element("div", undefined, "statement-row");
        const detail = element("div");
        detail.append(element("strong", row.description), element("small", `${row.date} · ${row.kind}`));
        item.append(detail, element("strong", money(row.amount)));
        return item;
    });
    $("statement-sample").replaceChildren(...rows);
    $("statement-preview").hidden = false;
}

for (const id of ["date", "description", "debit", "credit", "amount", "mode", "date-format", "account"]) {
    $("statement-" + id).addEventListener("change", invalidateStatementPreview);
    if (id === "account") $("statement-account").addEventListener("input", invalidateStatementPreview);
}
$("statement-close").addEventListener("click", closeStatementMapper);
$("statement-cancel").addEventListener("click", closeStatementMapper);
$("statement-dialog").addEventListener("close", () => { statementText = ""; statementName = ""; statementRevision++; });
$("statement-check").addEventListener("click", async () => {
    if (!statementText) return;
    const revision = statementRevision;
    $("statement-check").disabled = true;
    statementError();
    try {
        const preview = await request("/api/import/preview", {csv: statementText, options: statementOptions()});
        if (revision !== statementRevision) return;
        renderStatementPreview(preview);
        $("statement-import").disabled = false;
    } catch (error) {
        if (revision === statementRevision) statementError(error.message);
    } finally { $("statement-check").disabled = false; }
});
$("statement-form").addEventListener("submit", (event) => {
    event.preventDefault();
    if (!statementText || $("statement-import").disabled) return;
    const csv = statementText;
    const name = statementName;
    const options = statementOptions();
    action(async () => {
        try {
            const data = await request("/api/import/mapped", {name, csv, options});
            closeStatementMapper();
            useState(data);
            notice(data.duplicate ? "Opened the saved copy of this statement. Your edits are still here." : "Statement imported. Review the transaction types and categories below.");
        } catch (error) { statementError(error.message); }
    });
});
