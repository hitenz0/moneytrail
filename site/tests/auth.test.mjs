import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";

const script = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const ids = [...html.matchAll(/id="([^"]+)"/g)].map((match) => match[1]);

async function startApp(status) {
  const redirects = [];
  const elements = new Map(ids.map((id) => [id, {
    value: "", hidden: false, disabled: false,
    setAttribute() {}, addEventListener() {}, replaceChildren() {}, append() {},
  }]));
  const context = {
    Date, Intl,
    document: {
      getElementById(id) { assert.ok(elements.has(id), `Missing ${id}`); return elements.get(id); },
      querySelectorAll() { return []; },
      addEventListener() {},
    },
    window: { location: { assign(url) { redirects.push(url); } } },
    localStorage: { getItem() { return ""; }, setItem() {} },
    Option: class { constructor(text, value) { this.text = text; this.value = value; } },
    setInterval() {},
    fetch: async () => ({ status, ok: status === 200, json: async () => status === 200
      ? { datasets: [], report: null }
      : { error: "Sign in to MoneyTrail first." } }),
  };
  runInNewContext(script, context);
  await new Promise(setImmediate);
  return redirects;
}

test("hosted app sends unsigned visitors to ChatGPT sign-in", async () => {
  assert.deepEqual(await startApp(401), ["/signin-with-chatgpt?return_to=%2Findex.html"]);
});

test("hosted app stays on the dashboard for a signed-in user", async () => {
  assert.deepEqual(await startApp(200), []);
});
