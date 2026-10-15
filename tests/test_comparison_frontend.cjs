// Run with Node; synthetic fixtures and a small DOM stand-in.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
class Element {
    constructor(text = '') { this.textContent = text; this.children = []; this.value = ''; this.listeners = {}; this.attributes = {}; this.style = {setProperty() {}}; }
    append(...nodes) { this.children.push(...nodes); }
    replaceChildren(...nodes) { this.children = nodes; }
    addEventListener(name, fn) { this.listeners[name] = fn; }
    setAttribute(name, value) { this.attributes[name] = value; }
}
const source = path.join(__dirname, '..', 'src');
const html = fs.readFileSync(path.join(source, 'templates/index.html'), 'utf8');
const elements = Object.fromEntries([...html.matchAll(/id="([^"]+)"/g)].map((match) => [match[1], new Element()]));
let nextResponse;
const posts = [];
const context = vm.createContext({Date, Intl,
    document: {getElementById(id) { assert.ok(elements[id], id); return elements[id]; },
        createElement() { return new Element(); }, querySelectorAll() { return []; }, addEventListener() {}},
    Option: class extends Element { constructor(text, value) { super(text); this.value = value; } },
    localStorage: {getItem() { return ''; }, setItem() {}}, setInterval() {},
    fetch: async (url, options) => {
        if (!options.body) return {ok: true, json: async () => ({datasets: [], report: null})};
        assert.equal(url, '/api/compare');
        posts.push(JSON.parse(options.body));
        return await nextResponse;
    }});
for (const file of ['app.js', 'comparison.js']) vm.runInContext(fs.readFileSync(path.join(source, 'static', file), 'utf8'), context);
function run(code) { return vm.runInContext(code, context); }
function text(node) { return [node.textContent, ...node.children.map(text)].join(' '); }
function all(node) { return [node, ...node.children.flatMap(all)]; }
const row = {id: '1', date: '2026-09-10', description: '<img src=x onerror=alert(1)>', account: 'UPI', amount: '-500'};
const report = {
    before: {start: '2026-08-01', end: '2026-08-28', days: 28, transaction_count: 1, accounts: ['UPI'], summary: {purchases: '100', refunds: '0', net: '100'}, refund_transactions: []},
    after: {start: '2026-09-01', end: '2026-09-28', days: 28, transaction_count: 1, accounts: ['UPI'], summary: {purchases: '500', refunds: '20', net: '480'}, refund_transactions: [{...row, amount: '20'}]},
    changes: {purchases: '400', refunds: '20', net: '380'},
    categories: [{name: 'Food', change: '400', before: {total: '100', count: 2, average: '50', transactions: []}, after: {total: '500', count: 1, average: '500', transactions: [row]}}]
};
const submit = () => elements['comparison-form'].listeners.submit({preventDefault() {}});
async function main() {
    await new Promise(setImmediate);
    assert.equal(elements['comparison-section'].hidden, true);
    run(`updateComparison({datasets: [{id: 1, version: 1, name: 'All spending', first_date: '2026-08-01', last_date: '2026-09-28'}], report: {dataset: {id: 1}}})`);
    assert.equal(elements['comparison-section'].hidden, false);
    assert.equal(elements['compare-after-start'].value, '2026-09-01');
    assert.equal(elements['compare-before-end'].value, '2026-08-31');
    assert.equal(elements['compare-before-start'].value, '2026-08-04');
    elements['compare-before-start'].value = '2026-08-01';
    elements['compare-before-end'].value = '2026-08-28';
    nextResponse = {ok: true, json: async () => report};
    await submit();
    assert.equal(posts[0].before.dataset_id, 1);
    assert.equal(elements['comparison-results'].hidden, false);
    assert.match(text(elements['comparison-results']), /400 more/);
    assert.match(text(elements['comparison-results']), /380 more/);
    assert.match(text(elements['comparison-results']), /One purchase in the later period/);
    assert.match(text(elements['comparison-results']), /Refunds received/);
    const evidence = all(elements['comparison-results']).find((node) => node.children[0]?.textContent === 'Later purchases · 1 transactions');
    assert.equal(evidence.children[1].children.length, 0); // Evidence renders only when opened.
    evidence.open = true;
    evidence.listeners.toggle();
    assert.match(text(evidence), /<img src=x onerror=alert\(1\)>/); // Plain text, never HTML.
    assert.equal(evidence.children[1].children.length, 1);
    evidence.listeners.toggle();
    assert.equal(evidence.children[1].children.length, 1);
    assert.equal(elements['compare-submit'].disabled, false);

    nextResponse = {ok: false, json: async () => ({error: 'Choose the same number of days'})};
    await submit();
    assert.equal(elements['comparison-results'].hidden, true);
    assert.equal(elements['comparison-status'].attributes.role, 'alert');
    assert.match(elements['comparison-status'].textContent, /same number/);

    let resolve;
    nextResponse = new Promise((done) => resolve = done);
    const pending = submit();
    assert.equal(elements['compare-submit'].disabled, true);
    elements['compare-after-start'].listeners.input();
    resolve({ok: true, json: async () => report});
    await pending;
    assert.equal(elements['comparison-results'].hidden, true); // A stale response must not restore old results.
    assert.match(elements['comparison-status'].textContent, /Dates changed/);
    assert.equal(elements['compare-submit'].disabled, false);

    elements['compare-after-start'].value = '2024-03-01';
    elements['compare-after-end'].value = '2024-03-29';
    elements['compare-previous'].listeners.click();
    assert.equal(elements['compare-before-start'].value, '2024-02-01');
    assert.equal(elements['compare-before-end'].value, '2024-02-29');

    context.fixture = {...report, before: {...report.before, transaction_count: 0, accounts: []}};
    run('renderComparison(fixture)');
    assert.match(text(elements['comparison-results']), /does not confirm zero spending/);
    assert.match(text(elements['comparison-results']), /Account names differ/);
    const many = Array.from({length: 60}, (_, i) => ({...row, id: String(i)}));
    context.many = many;
    const paged = run("comparisonTransactions('Purchases', many)");
    paged.open = true;
    paged.listeners.toggle();
    assert.equal(paged.children[1].children.length, 25);
    paged.children[2].listeners.click();
    assert.equal(paged.children[1].children.length, 50);
    paged.children[2].listeners.click();
    assert.equal(paged.children[1].children.length, 60);
    assert.equal(paged.children[2].hidden, true);
    context.fixture = {...report, categories: Array.from({length: 10}, (_, i) => ({...report.categories[0], name: 'Category ' + i}))};
    run('renderComparison(fixture)');
    const moreCategories = all(elements['comparison-results']).find((node) => node.textContent === 'Show more categories');
    assert.equal(all(elements['comparison-results']).filter((node) => node.className === 'comparison-category').length, 8);
    moreCategories.listeners.click();
    assert.equal(all(elements['comparison-results']).filter((node) => node.className === 'comparison-category').length, 10);
    assert.equal(moreCategories.hidden, true);

    // A simultaneous dashboard save must not leave comparison controls disabled.
    nextResponse = new Promise((done) => resolve = done);
    const inFlight = submit();
    await run("action(async () => invalidateComparison('Saved import changed. Compare again.'))");
    resolve({ok: true, json: async () => report});
    await inFlight;
    assert.equal(elements['compare-submit'].disabled, false);
    assert.equal(elements['comparison-results'].hidden, true);
    console.log('Comparison UI checks passed (simulated DOM).');
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
