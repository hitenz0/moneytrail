let billsState = null;
let editingBill = null;

function localBillDate() {
    const now = new Date();
    return [now.getFullYear(), String(now.getMonth() + 1).padStart(2, "0"),
        String(now.getDate()).padStart(2, "0")].join("-");
}

function billMessage(message, error = false) {
    const node = $("bills-message");
    node.textContent = message;
    node.className = error ? "error small" : "note small";
    node.hidden = !message;
}

function useBills(data) {
    billsState = data;
    $("bills-week").textContent = money(data.summary.next_seven);
    $("bills-overdue").textContent = money(data.summary.overdue);
    $("bills-overdue-count").textContent = data.summary.overdue_count +
        (data.summary.overdue_count === 1 ? " bill to check" : " bills to check");
    $("bills-monthly").textContent = money(data.summary.monthly);
    renderBills();
}

function billDateLabel(value) {
    return new Intl.DateTimeFormat("en-IN", {day: "numeric", month: "short", year: "numeric"})
        .format(new Date(value + "T12:00:00"));
}

function billStatus(item) {
    if (item.status === "paused") return ["Paused", "paused"];
    if (item.status === "paid") return ["Paid", "received"];
    if (item.days_until < 0) return [item.payment_method === "autopay" ? "Check autopay" : "Past due", "bill-late"];
    if (item.days_until === 0) return ["Due today", "bill-soon"];
    if (item.days_until < 7) return ["Due in " + item.days_until + " days", "bill-soon"];
    return ["Upcoming", ""];
}

function renderBills() {
    if (!billsState) return;
    const filter = $("bills-filter").value;
    const items = billsState.items.filter((item) => {
        if (filter === "week") return item.status === "active" && item.days_until >= 0 && item.days_until < 7;
        if (filter === "overdue") return item.status === "active" && item.days_until < 0;
        if (filter === "inactive") return item.status !== "active";
        return item.status === "active";
    });
    $("bills-list").replaceChildren();
    if (!items.length) {
        const messages = {
            active: billsState.items.length ? "No active bills. Choose Paused & paid to see your saved bills." : "No bills yet. Add one to see what's due next week.",
            week: "Nothing is due in the next 7 days.",
            overdue: "No past-due bills to check.",
            inactive: "No paused or paid bills."
        };
        $("bills-list").append(element("p", messages[filter], "note bill-empty"));
        return;
    }
    items.forEach((item) => {
        const row = element("div", undefined, "bill-item");
        const details = element("div", undefined, "bill-details");
        const heading = element("div", undefined, "bill-heading");
        const status = billStatus(item);
        heading.append(element("strong", item.name), element("span", status[0], "status " + status[1]));
        const cadence = {once: "One time", weekly: "Weekly", monthly: "Monthly", quarterly: "Every 3 months", yearly: "Yearly"}[item.cadence];
        const method = item.payment_method === "autopay" ? "Autopay expected" : "You pay it";
        details.append(heading, element("p", billDateLabel(item.next_due) + " · " + cadence + " · " + method, "note small"));
        if (item.last_paid_on) details.append(element("p", "Last marked paid on " + billDateLabel(item.last_paid_on), "note small"));
        if (item.note) details.append(element("p", item.note, "bill-note note small"));
        const side = element("div", undefined, "bill-side");
        side.append(element("strong", money(item.amount), "bill-amount"));
        const controls = element("div", undefined, "bill-actions");
        if (item.status === "active") controls.append(button("Mark paid", () => changeBill(item, "pay"), "compact"));
        controls.append(button("Edit", () => openBill(item)));
        if (item.status === "active") controls.append(button("Pause", () => changeBill(item, "pause")));
        if (item.status === "paused") controls.append(button("Resume", () => changeBill(item, "resume")));
        if (item.last_paid_due) controls.append(button("Undo last payment", () => changeBill(item, "undo")));
        side.append(controls);
        row.append(details, side);
        $("bills-list").append(row);
    });
}

async function loadBills() {
    try {
        useBills(await request("/api/bills?today=" + localBillDate()));
        billMessage("");
    } catch (error) {
        billMessage(error.message, true);
        $("bills-list").replaceChildren(element("p", "Could not load bills. Refresh this page to try again.", "error"));
    }
}

function openBill(item = null) {
    editingBill = item;
    $("bill-dialog-title").textContent = item ? "Edit bill" : "Add a bill";
    $("bill-name").value = item?.name || "";
    $("bill-amount").value = item?.amount || "";
    $("bill-due").value = item?.next_due || localBillDate();
    $("bill-cadence").value = item?.cadence || "monthly";
    $("bill-method").value = item?.payment_method || "manual";
    $("bill-note").value = item?.note || "";
    $("bill-form-error").hidden = true;
    $("bill-dialog").showModal();
    $("bill-name").focus();
}

function changeBill(item, operation) {
    action(async () => {
        try {
            const result = await request("/api/bills", {action: operation, id: item.id, version: item.version, today: localBillDate()});
            useBills(result);
            billMessage(operation === "pay" ? "Payment marked. Check the updated next date below." :
                operation === "undo" ? "Last payment mark undone." : operation === "pause" ? "Bill paused." : "Bill resumed. Check its next date below.");
        } catch (error) { billMessage(error.message, true); }
    });
}

$("add-bill").addEventListener("click", () => openBill());
$("bill-close").addEventListener("click", () => $("bill-dialog").close());
$("bill-cancel").addEventListener("click", () => $("bill-dialog").close());
$("bills-filter").addEventListener("change", renderBills);
$("bill-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const fields = {name: $("bill-name").value.trim(), amount: $("bill-amount").value,
        cadence: $("bill-cadence").value, next_due: $("bill-due").value,
        payment_method: $("bill-method").value, note: $("bill-note").value.trim()};
    action(async () => {
        try {
            const result = await request("/api/bills", {action: "save", id: editingBill?.id || null,
                version: editingBill?.version || null, fields, today: localBillDate()});
            useBills(result);
            $("bill-dialog").close();
            billMessage("Bill saved. Its next date is shown below.");
        } catch (error) {
            $("bill-form-error").textContent = error.message;
            $("bill-form-error").hidden = false;
        }
    });
});

setInterval(() => { if (billsState && !document.hidden && billsState.today !== localBillDate()) loadBills(); }, 60000);
document.addEventListener("visibilitychange", () => { if (billsState && !document.hidden && billsState.today !== localBillDate()) loadBills(); });
loadBills();
