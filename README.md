# MoneyTrail

I use UPI and a credit card, and it can be hard to see where small spends went or whether a refund actually came back. MoneyTrail is a project I'm building around those two questions.

## Run the web app

Requires Python 3.10 or newer. There are no extra packages to install.

```powershell
python app.py
```

Open [MoneyTrail](http://127.0.0.1:8001) in your browser. Keep the terminal running; Ctrl+C stops the server. If the port is busy, run `python app.py --port 8002` and use the address it prints. Opening `index.html` directly or using a plain static server will not run the app.

## What works

- Import a transaction CSV and switch between saved imports.
- See purchases, refund credits, net spending, and refunds still due.
- See spending by category, search transactions, and filter by transaction type.
- Accept a category suggestion or enter your own category.
- Mark a purchase as expecting a full or partial refund.
- Review suggested refund links, choose a purchase manually, or undo a link.
- Download a CSV containing your reviewed categories and refund links.

Edits are saved in `data/moneytrail.db`, a local SQLite database excluded from Git. Reloading the page or restarting the server keeps your work. The original CSV is not changed. Reimporting the same original transaction data reopens its saved workspace, including edits; a different import gets a separate workspace. Links stay within one import, so include the purchase and its later refund in the same CSV.

## Try the demo

Click **Load student demo**. All of its transactions are synthetic.

1. It starts with INR 4,480 in purchases, INR 1,200 in refund credits, and INR 3,280 in net spending. A card-bill payment is excluded from spending.
2. The bookstore purchase expects INR 1,200 back, with INR 900 already linked. Confirm the suggested INR 300 credit: the bookstore status changes to **Received**, and total refunds still due drops from INR 2,100 to INR 1,800.
3. Net spending stays INR 3,280 because that credit was already in the statement. Confirming its link only changes the watchlist.
4. Click **Use Food** for the Swiggy purchase. Its INR 320 moves from Uncategorized to Food.
5. Use **Edit** to enter another category or expected refund amount. Refresh to check the saved result, then download the reviewed CSV.

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

## Current scope

This is a local app for one person, bound to 127.0.0.1. It has no bank connection, login system, or public hosting. Imports are separate workspaces rather than a combined account history. The interface is a working starting point; the visual design is still being developed.
