// Run with node test_bills_frontend.cjs. Uses only Node's built-in modules.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

class Element {
    constructor() { this.children = []; this.value = ''; this.textContent = ''; this.style = {}; this.listeners = {}; }
    append(...items) { this.children.push(...items); }
    replaceChildren(...items) { this.children = items; }
    addEventListener(name, handler) { this.listeners[name] = handler; }
    setAttribute() {}
    showModal() { this.open = true; }
    close() { this.open = false; }
    focus() {}
}

const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
const elements = Object.fromEntries([...html.matchAll(/id="([^"]+)"/g)].map((match) => [match[1], new Element()]));
const posted = [];
const first = {id: 1, version: 1, name: 'Music', amount: '199.00', cadence: 'monthly', next_due: '2026-10-12',
    note: '<script>not HTML</script>', payment_method: 'autopay', status: 'active', days_until: 2, last_paid_on: '', last_paid_due: ''};
const second = {id: 2, version: 1, name: 'Internet', amount: '999.00', cadence: 'monthly', next_due: '2026-10-09',
    note: '', payment_method: 'autopay', status: 'active', days_until: -1, last_paid_on: '', last_paid_due: ''};
const initial = {today: '2026-10-10', items: [second, first],
    summary: {monthly: '1198.00', next_seven: '199.00', overdue: '999.00', active_count: 2, overdue_count: 1}};
const paid = {today: '2026-10-10', items: [{...first, version: 2, next_due: '2026-11-12', days_until: 33,
    last_paid_due: '2026-10-12', last_paid_on: '2026-10-10'}, second],
    summary: {monthly: '1198.00', next_seven: '0', overdue: '999.00', active_count: 2, overdue_count: 1}};
let nextPost = paid;
class Today extends Date { constructor(...args) { super(...(args.length ? args : [2026, 9, 10, 12])); } }
const context = vm.createContext({Date: Today, Intl,
    document: {hidden: false, getElementById(id) { assert.ok(elements[id], `Missing ${id}`); return elements[id]; },
        createElement() { return new Element(); }, querySelectorAll() { return Object.values(elements); }, addEventListener() {}},
    Option: class extends Element { constructor(text, value) { super(); this.textContent = text; this.value = value; } },
    localStorage: {getItem() { return ''; }, setItem() {}}, setInterval() {},
    fetch: async (url, options) => {
        if (options.body) { posted.push(JSON.parse(options.body)); return {ok: true, json: async () => nextPost}; }
        return {ok: true, json: async () => url.startsWith('/api/bills') ? initial : {datasets: [], report: null}};
    }});
vm.runInContext(fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8'), context);
vm.runInContext(fs.readFileSync(path.join(__dirname, 'bills.js'), 'utf8'), context);

async function main() {
    await new Promise(setImmediate);
    assert.match(elements['bills-week'].textContent, /199/);
    assert.match(elements['bills-overdue'].textContent, /999/);
    assert.equal(elements['bills-list'].children.length, 2);
    assert.equal(elements['bills-list'].children[0].children[0].children[0].children[1].textContent, 'Check autopay');
    assert.equal(elements['bills-list'].children[1].children[0].children[2].textContent, first.note);
    elements['bills-filter'].value = 'week'; elements['bills-filter'].listeners.change();
    assert.equal(elements['bills-list'].children.length, 1);
    assert.equal(elements['bills-list'].children[0].children[0].children[0].children[0].textContent, 'Music');
    elements['bills-filter'].value = 'overdue'; elements['bills-filter'].listeners.change();
    assert.equal(elements['bills-list'].children[0].children[0].children[0].children[0].textContent, 'Internet');
    elements['bills-filter'].value = 'active'; elements['bills-filter'].listeners.change();

    context.changeBill(first, 'pay');
    await new Promise(setImmediate);
    assert.equal(posted[0].action, 'pay');
    assert.equal(posted[0].today, '2026-10-10');
    assert.match(elements['bills-week'].textContent, /0/);
    assert.match(elements['bills-message'].textContent, /updated next date/);

    context.openBill(first);
    assert.equal(elements['bill-method'].value, 'autopay');
    assert.equal(elements['bill-due'].value, '2026-10-12');
    elements['bill-name'].value = 'Music plan';
    elements['bill-form'].listeners.submit({preventDefault() {}});
    await new Promise(setImmediate);
    assert.equal(posted[1].fields.name, 'Music plan');
    assert.equal(posted[1].fields.payment_method, 'autopay');
    assert.equal(elements['bill-dialog'].open, false);

    context.openBill();
    assert.equal(elements['bill-due'].value, '2026-10-10');
    assert.equal(elements['bill-method'].value, 'manual');
    console.log('Bill frontend checks passed: seven-day and past-due filters, autopay label, payment, and edit form.');
}

module.exports = main();
module.exports.catch((error) => { console.error(error); process.exitCode = 1; });
