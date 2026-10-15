const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

class Element {
    constructor(text = '') { this.textContent = text; this.children = []; this.value = ''; this.listeners = {}; this.hidden = false; this.disabled = false; }
    addEventListener(name, handler) { this.listeners[name] = handler; }
    replaceChildren(...children) { this.children = children; }
    append(...children) { this.children.push(...children); }
    showModal() { this.open = true; }
    close() { this.open = false; }
}

async function main() {
    const root = path.join(__dirname, '..', 'src');
    const html = fs.readFileSync(path.join(root, 'templates', 'index.html'), 'utf8');
    const elements = Object.fromEntries([...html.matchAll(/id="([^"]+)"/g)].map((match) => [match[1], new Element()]));
    const calls = [];
    let saved;
    let actionDone;
    const context = vm.createContext({
        $: (id) => { assert.ok(elements[id], id); return elements[id]; },
        Option: class extends Element { constructor(text, value) { super(text); this.value = value; } },
        element: (tag, text, className) => { const node = new Element(text); node.tag = tag; node.className = className; return node; },
        money: (amount) => 'INR ' + amount,
        request: async (url, body) => {
            calls.push(url);
            if (url.endsWith('/inspect')) return {count: 2, headers: ['Date', 'Details', 'Debit', 'Credit'],
                suggested: {date: 'Date', description: 'Details', debit: 'Debit', credit: 'Credit', amount: '', date_format: 'iso', mode: 'split'}};
            if (url.endsWith('/preview')) return {count: 2, counts: {purchase: 1, refund: 1, transfer: 0},
                sample: [{date: '2026-10-14', description: 'Cafe', kind: 'purchase', amount: '-75'}]};
            return {datasets: [{id: 1}], report: {dataset: {id: 1}}, duplicate: false};
        },
        action: (work) => { actionDone = work(); return actionDone; },
        useState: (state) => { saved = state; },
        notice: () => {},
    });
    vm.runInContext(fs.readFileSync(path.join(root, 'static', 'statement-import.js'), 'utf8'), context);
    await context.openStatementMapper('bank.csv', 'raw data');
    assert.equal(elements['statement-dialog'].open, true);
    assert.equal(elements['statement-mode'].value, 'split');
    assert.equal(elements['statement-import'].disabled, true);
    await elements['statement-check'].listeners.click();
    assert.equal(elements['statement-import'].disabled, false);
    assert.equal(elements['statement-sample'].children.length, 1);
    elements['statement-date-format'].value = 'dmy_slash';
    elements['statement-date-format'].listeners.change();
    assert.equal(elements['statement-import'].disabled, true);
    await elements['statement-check'].listeners.click();
    elements['statement-form'].listeners.submit({preventDefault() {}});
    await actionDone;
    assert.equal(saved.report.dataset.id, 1);
    assert.equal(elements['statement-dialog'].open, false);
    assert.deepEqual(calls, ['/api/import/inspect', '/api/import/preview', '/api/import/preview', '/api/import/mapped']);
    console.log('Statement mapper UI checks passed.');
}

module.exports = main();
module.exports.catch((error) => { console.error(error); process.exitCode = 1; });
