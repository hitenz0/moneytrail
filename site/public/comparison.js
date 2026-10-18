// Uses the dashboard's request, element, money and date helpers.
let comparisonDatasets = [];
let comparisonRevision = "";
let comparisonRequest = 0;
let comparisonLoading = false;

function syncComparisonControls() {
    $("compare-submit").disabled = busy || comparisonLoading;
}

function shiftComparisonDate(value, days) {
    const date = new Date(value + "T00:00:00Z");
    date.setUTCDate(date.getUTCDate() + days);
    return Number.isFinite(date.getTime()) && date.getUTCFullYear() >= 1 && date.getUTCFullYear() <= 9999 ? date.toISOString().slice(0, 10) : "";
}

function comparisonSelection(side) {
    return {dataset_id: Number($("compare-" + side + "-dataset").value),
        start: $("compare-" + side + "-start").value, end: $("compare-" + side + "-end").value};
}

function comparisonMessage(message, error = false) {
    $("comparison-status").textContent = message;
    $("comparison-status").className = error ? "error" : "note";
    $("comparison-status").setAttribute("role", error ? "alert" : "status");
}

function invalidateComparison(message = "Dates changed. Compare again to update the results.") {
    comparisonRequest++;
    $("comparison-results").hidden = true;
    $("comparison-results").replaceChildren();
    comparisonLoading = false;
    syncComparisonControls();
    $("comparison-section").setAttribute("aria-busy", "false");
    comparisonMessage(message);
}

function comparisonSource(side, resetDates = false) {
    const selected = comparisonSelection(side);
    const dataset = comparisonDatasets.find((item) => item.id === selected.dataset_id);
    $("compare-" + side + "-source").textContent = dataset?.first_date ?
        "Transaction dates: " + formatDate(dataset.first_date) + " – " + formatDate(dataset.last_date) : "";
    if (resetDates && dataset?.last_date) {
        $("compare-" + side + "-end").value = dataset.last_date;
        $("compare-" + side + "-start").value = shiftComparisonDate(dataset.last_date, -27);
    }
}

function precedingComparisonPeriod() {
    const after = comparisonSelection("after");
    const days = Math.round((new Date(after.end + "T00:00:00Z") - new Date(after.start + "T00:00:00Z")) / 86400000) + 1;
    if (!Number.isFinite(days) || days < 1) {
        comparisonMessage("Enter a valid later period first.", true);
        return;
    }
    $("compare-before-end").value = shiftComparisonDate(after.start, -1);
    $("compare-before-start").value = shiftComparisonDate(after.start, -days);
    invalidateComparison("Earlier dates now cover the " + days + " days immediately before the later period. Check your selected imports, then compare.");
}

function updateComparison(data) {
    const revision = JSON.stringify([data.report?.dataset.id, data.datasets.map((item) => [item.id, item.version])]);
    if (revision === comparisonRevision) return;
    comparisonRevision = revision;
    comparisonDatasets = data.datasets;
    $("comparison-section").hidden = !data.report;
    invalidateComparison("Choose two periods to compare. Dates start with 28-day windows; adjust them to match your statements.");
    for (const side of ["before", "after"]) {
        const select = $("compare-" + side + "-dataset");
        const previous = Number(select.value);
        select.replaceChildren(...data.datasets.map((item) => new Option(item.name + " · #" + item.id, item.id)));
        select.value = data.datasets.some((item) => item.id === previous) ? previous : (data.report?.dataset.id || "");
        comparisonSource(side, !previous);
    }
    if (data.report && !$("compare-before-start").value) comparisonSource("before", true);
    if (data.report && comparisonSelection("before").end >= comparisonSelection("after").start) {
        const earlier = data.datasets.filter((item) => item.last_date < comparisonSelection("after").start)
            .sort((a, b) => b.last_date.localeCompare(a.last_date))[0];
        if (earlier) {
            $("compare-before-dataset").value = earlier.id;
            comparisonSource("before", true);
        } else precedingComparisonPeriod();
    }
}

function comparisonDelta(value) {
    return Number(value) === 0 ? "No change" : money(Math.abs(Number(value))) + (Number(value) > 0 ? " more" : " less");
}

function comparisonTransactions(title, rows) {
    const details = element("details", undefined, "comparison-transactions");
    details.append(element("summary", title + " · " + rows.length + " transactions"));
    const list = element("div");
    let shown = 0;
    const more = button("Show more", () => appendPage());
    function appendPage() {
        rows.slice(shown, shown + 25).forEach((row) => {
            const item = element("div", undefined, "comparison-transaction");
            const description = element("div");
            description.append(element("strong", row.description), element("p", formatDate(row.date) + " · " + row.account + " · " + row.id, "note small"));
            item.append(description, element("strong", money(Math.abs(Number(row.amount)))));
            list.append(item);
        });
        shown += 25;
        more.hidden = shown >= rows.length;
    }
    details.addEventListener("toggle", () => {
        if (details.open && shown === 0) {
            if (!rows.length) list.append(element("p", "No transactions in this period.", "note"));
            appendPage();
        }
    });
    details.append(list, more);
    return details;
}

function renderComparison(data) {
    const results = $("comparison-results");
    results.replaceChildren();
    const warnings = [];
    for (const side of ["before", "after"]) {
        const period = data[side];
        const label = side === "before" ? "Earlier" : "Later";
        if (!period.transaction_count) warnings.push(label + " period has no imported transactions; that does not confirm zero spending.");
        else if (period.outside_observed_dates) warnings.push(label + " period extends beyond this import's transaction dates. Check that the statement covers the whole period.");
    }
    if (JSON.stringify(data.before.accounts) !== JSON.stringify(data.after.accounts)) {
        warnings.push("Account names differ between periods. Missing accounts can change the comparison.");
    }
    if (warnings.length) results.append(element("p", warnings.join(" "), "comparison-warning"));
    results.append(element("p", data.before.days + " days each · " + formatDate(data.before.start) + " – " + formatDate(data.before.end) + " → " + formatDate(data.after.start) + " – " + formatDate(data.after.end), "note small"));
    const stats = element("div", undefined, "comparison-stats");
    for (const [key, title] of [["purchases", "Purchase spending"], ["refunds", "Refund credits"], ["net", "Net spending"]]) {
        const stat = element("div");
        stat.append(element("span", title, "note small"), element("strong", comparisonDelta(data.changes[key])),
            element("p", money(data.before.summary[key]) + " → " + money(data.after.summary[key]), "note small"));
        stats.append(stat);
    }
    results.append(stats, element("h3", "Where the difference came from"));
    if (!data.categories.length) results.append(element("p", "No purchases in either selected period. Check your imports and dates.", "note"));
    const largestChange = Math.max(1, ...data.categories.map((item) => Math.abs(Number(item.change))));
    const categories = element("div");
    let shownCategories = 0;
    const moreCategories = button("Show more categories", appendCategories);
    function appendCategories() {
        data.categories.slice(shownCategories, shownCategories + 8).forEach((item) => {
            const row = element("div", undefined, "comparison-category");
            const heading = element("div", undefined, "comparison-category-heading");
            heading.append(element("h4", item.name), element("strong", comparisonDelta(item.change)));
            const track = element("div", undefined, "track");
            const fill = element("div", undefined, "fill");
            fill.style.width = Math.abs(Number(item.change)) / largestChange * 100 + "%";
            track.append(fill);
            const earlier = item.before;
            const later = item.after;
            const average = (value) => value === null ? "—" : money(value);
            const facts = money(earlier.total) + " → " + money(later.total) + " · " + earlier.count + " → " + later.count +
                " purchases · Average " + average(earlier.average) + " → " + average(later.average);
            row.append(heading, track, element("p", facts, "note small"));
            if (later.count === 1) {
                row.append(element("p", "One purchase in the later period: " + later.transactions[0].description + " (" + money(later.total) + ").", "comparison-explanation"));
            } else if (!earlier.count && later.count) {
                row.append(element("p", "Spending appears in this category in the later period only.", "comparison-explanation"));
            } else if (!later.count && earlier.count) {
                row.append(element("p", "No purchases in this category in the later period.", "comparison-explanation"));
            } else if (earlier.count && later.count) {
                const frequency = later.count === earlier.count ? "The same number of purchases" : later.count > earlier.count ? "More purchases" : "Fewer purchases";
                const cost = Number(later.average) === Number(earlier.average) ? "the same average purchase cost" : Number(later.average) > Number(earlier.average) ? "a higher average purchase cost" : "a lower average purchase cost";
                row.append(element("p", frequency + ", with " + cost + ".", "comparison-explanation"));
            }
            const evidence = element("div", undefined, "comparison-evidence");
            evidence.append(comparisonTransactions("Earlier purchases", earlier.transactions), comparisonTransactions("Later purchases", later.transactions));
            row.append(evidence);
            categories.append(row);
        });
        shownCategories += 8;
        moreCategories.hidden = shownCategories >= data.categories.length;
    }
    appendCategories();
    results.append(categories, moreCategories);
    if (data.before.refund_transactions.length || data.after.refund_transactions.length) {
        results.append(element("h3", "Refunds received"), element("p", "Credits affect net spending on their received date, even when the original purchase was in another period.", "note small"));
        const refunds = element("div", undefined, "comparison-evidence");
        refunds.append(comparisonTransactions("Earlier refunds", data.before.refund_transactions), comparisonTransactions("Later refunds", data.after.refund_transactions));
        results.append(refunds);
    }
    results.hidden = false;
}

$("comparison-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    invalidateComparison("Comparing your saved transactions…");
    const token = comparisonRequest;
    comparisonLoading = true;
    syncComparisonControls();
    $("comparison-section").setAttribute("aria-busy", "true");
    try {
        const data = await request("/api/compare", {before: comparisonSelection("before"), after: comparisonSelection("after")});
        if (token !== comparisonRequest) return;
        renderComparison(data);
        comparisonMessage("Comparison updated. Categories are ordered by the size of the change.");
    } catch (error) {
        if (token === comparisonRequest) comparisonMessage(error.message, true);
    } finally {
        if (token === comparisonRequest) {
            comparisonLoading = false;
            syncComparisonControls();
            $("comparison-section").setAttribute("aria-busy", "false");
        }
    }
});
for (const side of ["before", "after"]) {
    $("compare-" + side + "-dataset").addEventListener("change", () => {
        comparisonSource(side, true);
        invalidateComparison();
    });
    for (const field of ["start", "end"]) $("compare-" + side + "-" + field).addEventListener("input", () => invalidateComparison());
}
$("compare-previous").addEventListener("click", precedingComparisonPeriod);
updateComparison(state);
