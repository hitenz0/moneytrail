# MoneyTrail

I use UPI and a credit card, and it can be hard to see where small spends went or whether a refund actually came back. MoneyTrail is a project I'm building around those two questions.

## Run the web app

Requires Python 3.10 or newer. There are no extra packages to install.

```powershell
python app.py
```

Open [MoneyTrail](http://127.0.0.1:8001) in your browser. Keep the terminal running; Ctrl+C stops the server. If the port is busy, run `python app.py --port 8002` and use the address it prints. Opening `index.html` directly or using a plain static server will not run the app.

## What works

- Switch between light and dark mode in the header. The app starts with your device's theme and remembers your choice in this browser.
- Import a transaction CSV and switch between saved imports.
- See purchases, refund credits, net spending, and refunds still due.
- See spending by category, search transactions, and filter by transaction type.
- Accept a category suggestion or enter your own category.
- Mark a purchase as expecting a full or partial refund.
- Set an expected refund date, keep a short note, and filter the watchlist to overdue refunds.
- Add one-time bills or recurring subscriptions, see what's due over the next seven days, and flag past-due payments.
- Review suggested refund links, choose a purchase manually, or undo a link.
- Download a CSV containing your reviewed categories and refund links.

Edits are saved in `data/moneytrail.db`, a local SQLite database excluded from Git. Reloading the page or restarting the server keeps your work. The original CSV is not changed. Reimporting the same original transaction data reopens its saved workspace, including edits; a different import gets a separate workspace. Links stay within one import, so include the purchase and its later refund in the same CSV.

## Bills and subscriptions

Use **Add a bill** to enter an amount, next payment date, and whether the bill is one-time, weekly, monthly, every three months, or yearly. Bills are saved locally and appear even when you have not imported a CSV. They are shared across saved imports, so changing statements does not hide your bill deadlines. You can edit or pause a bill, filter to the next seven days or past-due bills, and see the amount due from today through six days ahead. Past-due amounts are shown separately. Dates use your browser's local calendar day.

Choose **Autopay** only as a label for a payment you expect the provider to take automatically. MoneyTrail does not set up, cancel, verify, or make payments. When an autopay date passes, check your bank or provider before marking it paid. **Mark paid** advances a recurring bill by one billing period; a one-time bill moves to the paid list. **Undo last payment** reverses the latest mark. Pausing a bill keeps its next date, so check or edit that date when you resume. Imported spending totals remain based on your CSV and are not changed by bill tracking.

The monthly recurring average combines active weekly, monthly, quarterly, and yearly amounts as 52/12, 1, 1/3, and 1/12 months respectively. One-time and paused bills are excluded. It is an average for planning; actual payment dates and amounts are shown in the bill list.

## Try the demo

Click **Load student demo**. All of its transactions are synthetic.

1. It starts with INR 4,480 in purchases, INR 1,200 in refund credits, and INR 3,280 in net spending. A card-bill payment is excluded from spending.
2. The bookstore purchase expects INR 1,200 back, with INR 900 already linked. Confirm the suggested INR 300 credit: the bookstore status changes to **Received**, and total refunds still due drops from INR 2,100 to INR 1,800.
3. Net spending stays INR 3,280 because that credit was already in the statement. Confirming its link only changes the watchlist.
4. Click **Use Food** for the Swiggy purchase. Its INR 320 moves from Uncategorized to Food.
5. Use **Edit** to enter another category or expected refund amount. Refresh to check the saved result, then download the reviewed CSV.
6. Choose **Edit refund details** on a watchlist item. Add the date the merchant gave you and an optional note, then save. Use **Overdue only** to see refunds whose expected dates have passed and still have money due.

The demo is saved too. Loading it again reopens your edited copy.

## CSV format

Use UTF-8 text, dates like `2026-09-05`, and these columns:

```csv
id,date,description,amount,account,kind,category,refund_expected,refund_for
p1,2026-09-05,BOOKSTORE ONLINE,-1200.00,Card,purchase,Shopping,1200.00,
r1,2026-09-12,BOOKSTORE PARTIAL REFUND,900.00,Card,refund,,,p1
r2,2026-09-15,BOOKSTORE FINAL REFUND,300.00,Card,refund,,,
```

Each transaction needs a unique ID within its file. Purchases have negative amounts, refunds have positive amounts, and `kind` is `purchase`, `refund`, or `transfer`. Money values support up to two decimal places and must be below one billion INR. The web importer accepts up to 2 MB and 10,000 rows. It validates the whole file before saving.

Leave `category` blank to review it later. Leave `refund_expected` blank or use 0 if you are not tracking a refund. On a refund row, `refund_for` is the original purchase's ID; leave it blank until you confirm the link.

Two optional columns, `refund_due` and `refund_note`, store follow-up details on purchases. `refund_due` uses YYYY-MM-DD and cannot be before the purchase date. `refund_note` allows up to 200 characters. Older CSVs work without either column; reviewed CSV downloads include both. Saved databases are upgraded automatically, preserving existing imports and edits.

Expected dates are entered by you, based on what the merchant told you. A refund becomes overdue the day after that date, using your browser's local calendar date, while money is still due. A date of today shows **Due today**. Purchases without a date, fully received refunds, and purchases with no expected refund amount are never marked overdue. Linking the final refund removes an item from the overdue filter; its date and note remain saved. The filter only changes the watchlist, so overview totals stay the same. This feature does not send notifications.

Bank exports may need their columns converted to this format first.

## Calculation rules

Purchases count as spending. Transfers such as card-bill payments do not. Actual refund credits reduce net spending whether or not they have been linked. An expected refund never reduces spending on its own.

The watchlist uses only confirmed links. It supports several credits for one purchase, and partial returns where the expected refund is smaller than the purchase price. If linked credits exceed the expected refund, the full received amount is shown and the amount still due stays at zero.

Category suggestions use a small keyword list. Ambiguous or unknown descriptions remain Uncategorized until reviewed. Refund suggestions need a shared description word, a refund date on or after the purchase, and an amount no larger than what is still due. These clues can miss a real match or suggest the wrong purchase; the user makes the final choice.

## How the code fits together

| File | Job |
| --- | --- |
| `main.py` | Parse CSVs and calculate totals, categories, watchlists, and suggestions |
| `app.py` | Serve the local API and save imports and edits in SQLite |
| `app.js` | Load API results and handle browser actions |
| `index.html`, `style.css` | Page structure and appearance |
| `test_main.py`, `test_app.py` | Calculation, command-line, storage, and API checks |

The browser asks Python for the report. Saving an edit validates it, writes it to SQLite, and recalculates the report. Money calculations use Python's `Decimal`. If two tabs edit the same import, a stale save is rejected so it cannot quietly overwrite a newer edit.

## Terminal version

The original terminal report still works:

```powershell
python main.py
python main.py examples/unlinked_refund.csv
python main.py examples/uncategorized.csv
python main.py "D:\statements\october transactions.csv"
python main.py --help
```

This command reads a CSV without changing it. It does not read edits saved in the web app unless you download the reviewed CSV and pass that file.

## Checks

```powershell
python -m unittest -v
```

Tests use temporary databases and synthetic data. They cover partial refunds, duplicate imports, persistence, invalid updates, stale edits, CSV export, and the HTTP API.

If Node.js is available, run `node test_frontend.cjs` for theme switching and persistence, date labels, the overdue filter, and edit-form checks. These use a small simulated DOM; they do not replace a visual browser check. The app itself still only requires Python.

Run `node test_bills_frontend.cjs` to check the bill filters, autopay label, and edit actions in a simulated DOM.

## Current scope

This is a local app for one person, bound to 127.0.0.1. It has no bank connection, login system, or public hosting. Imports are separate workspaces rather than a combined account history. Bill dates are entered manually, and the app does not send notifications. The interface is a working starting point; the visual design is still being developed.
