// Run with node test_frontend.cjs. Uses only Node's built-in modules.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

class Element {
    constructor(text = '') {
        this.textContent = text;
        this.children = [];
        this.value = '';
        this.style = {};
        this.listeners = {};
    }
    append(...nodes) { this.children.push(...nodes); }
    replaceChildren(...nodes) { this.children = nodes; }
    addEventListener(name, handler) { this.listeners[name] = handler; }
    setAttribute() {}
    showModal() { this.open = true; }
    close() { this.open = false; }
}

const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
const elements = Object.fromEntries([...html.matchAll(/id="([^"]+)"/g)].map((match) => [match[1], new Element()]));
const posts = [];
class Today extends Date {
    constructor(...args) { super(...(args.length ? args : [2026, 9, 9, 0, 1])); }
}
const context = vm.createContext({
    Date: Today, Intl,
    document: {
        getElementById(id) { assert.ok(elements[id], `Missing HTML element: ${id}`); return elements[id]; },
        createElement() { return new Element(); },
        querySelectorAll() { return Object.values(elements); },
        addEventListener() {},
    },
    Option: class extends Element { constructor(text, value) { super(text); this.value = value; } },
    localStorage: {getItem() { return ''; }, setItem() {}},
    setInterval() {},
    fetch: async (url, options) => {
        if (options.body) posts.push(JSON.parse(options.body));
        return {ok: true, json: async () => ({datasets: [], report: null})};
    },
});
vm.runInContext(fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8'), context);

async function main() {
    await new Promise(setImmediate); // Let the initial state request finish.
    const timing = (due, remaining = '300') => context.refundTiming({refund_due: due, remaining});
    assert.equal(timing('').overdue, false);
    assert.match(timing('2026-10-07').label, /2 days overdue/);
    assert.match(timing('2026-10-08').label, /1 day overdue/);
    assert.match(timing('2026-10-09').label, /Due today/);
    assert.equal(timing('2026-10-09').overdue, false);
    assert.equal(timing('2026-10-10').overdue, false);
    assert.equal(timing('2026-10-07', '0').overdue, false);
    assert.doesNotMatch(timing('2026-10-07', '0').label, /overdue/);
    assert.match(context.refundTiming({refund_due: '2026-09-30', remaining: '300'}, new Date(2026, 9, 1)).label, /1 day overdue/);

    const purchase = {id: 'p1', date: '2026-09-05', description: 'Bookstore', account: 'Card',
        kind: 'purchase', amount: '-1200', category: 'Shopping', refund_expected: '1200',
        refund_for: '', refund_due: '2026-10-07', refund_note: '<b>Order 42</b>\nCall merchant'};
    const refund = {id: 'r1', date: '2026-09-12', description: 'Bookstore refund', account: 'Card',
        kind: 'refund', amount: '900', category: '', refund_expected: '0', refund_for: 'p1'};
    const item = {id: 'p1', description: 'Bookstore', expected: '1200', received: '900', remaining: '300',
        status: 'Partly received', refund_due: purchase.refund_due, refund_note: purchase.refund_note};
    const dataset = {id: 1, name: 'Demo', version: 1};
    const state = {datasets: [dataset], report: {dataset, transactions: [purchase, refund],
        summary: {purchases: '1200', refunds: '900', net: '300', still_due: '300'},
        categories: {Shopping: '1200'}, watchlist: [item], refund_suggestions: [], category_suggestions: {}}};
    context.useState(state);
    assert.equal(elements['watch-count'].textContent, '1 OPEN · 1 OVERDUE');
    assert.equal(elements.watchlist.children.length, 1);
    const card = elements.watchlist.children[0];
    assert.match(card.children[1].textContent, /2 days overdue/);
    assert.equal(card.children[4].textContent, purchase.refund_note); // Notes remain literal text.

    elements['watch-filter'].value = 'overdue';
    elements['watch-filter'].listeners.change();
    assert.equal(elements.watchlist.children[0].className, 'watch-item');
    item.remaining = '0'; item.status = 'Received'; item.received = '1200';
    context.useState(state);
    assert.equal(elements['watch-count'].textContent, '0 OPEN · 0 OVERDUE');
    assert.match(elements.watchlist.children[0].textContent, /No overdue refunds/);
    elements['watch-filter'].value = 'all';
    elements['watch-filter'].listeners.change();
    assert.equal(elements.watchlist.children[0].className, 'watch-item');
    assert.doesNotMatch(elements.watchlist.children[0].children[1].textContent, /overdue/);

    context.openEdit('p1');
    assert.equal(elements['followup-fields'].hidden, false);
    assert.equal(elements['edit-due'].value, '2026-10-07');
    assert.equal(elements['edit-due'].min, '2026-09-05');
    assert.equal(elements['edit-note'].value, purchase.refund_note);
    context.openEdit('r1');
    assert.equal(elements['followup-fields'].hidden, true);
    assert.equal(elements['edit-due'].value, '');
    context.openEdit('p1');
    elements['edit-due'].value = '2026-10-12';
    elements['edit-note'].value = '  Merchant extended the date  ';
    elements['edit-form'].listeners.submit({preventDefault() {}});
    await new Promise(setImmediate);
    assert.equal(posts[0].changes.refund_due, '2026-10-12');
    assert.equal(posts[0].changes.refund_note, 'Merchant extended the date');
    assert.equal(elements['edit-dialog'].open, false);
    console.log('Frontend checks passed: dates, partial/complete refunds, filter, notes, edit form, and save payload.');
}

module.exports = main();
module.exports.catch((error) => { console.error(error); process.exitCode = 1; });
