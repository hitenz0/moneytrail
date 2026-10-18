# MoneyTrail Web

A private, hosted version of MoneyTrail. The existing interface is served from `public/`; API routes run on Cloudflare Workers and keep each signed-in user's imports, edits, and bill schedules in D1.

The site starts owner-only. Visitors sign in with ChatGPT. API routes require identity and filter every read and write by user ID. The site does not connect to a bank or make payments.

## Local development

Use Node 22.13 or newer. Install dependencies with `npm ci`, generate migrations with `npm run db:generate` after changing `db/schema.ts`, then build with `npm run build`. Apply each pending SQL file in `drizzle/` to local D1 with `node --import ./scripts/sites-env.mjs ./node_modules/wrangler/bin/wrangler.js d1 execute DB --local --config dist/server/wrangler.json --persist-to .wrangler/state --file drizzle/FILE.sql`. Run `npm run dev` and open `/signin-with-chatgpt?return_to=/` to use the local mock account.

Run `node --test tests/core.test.mjs` for calculation, CSV, statement mapping, and comparison checks. The API also needs a local D1 smoke check before publishing.

## Data

Hosted data starts empty and remains separate from the local Python app's `data/moneytrail.db`. To bring a reviewed import over, download its reviewed CSV from the local app and import that file in the hosted site. Bills can be re-entered. Keep the local database as your backup until you have checked the hosted results. Do not commit real statements, database files, or credentials.

The original Python app remains in the `money` repository. This hosted port preserves its spending and refund calculations, mapped CSV import, comparison, and bill flows. Source data limits remain 2 MB and 10,000 rows per import.
