# MoneyTrail

I use UPI and a credit card, and it can be hard to see where small spends went or whether a refund actually came back. MoneyTrail is a small project I'm building around those two questions.

The project will grow in small steps. The Python script reads a simple CSV of sample transactions and calculates spending. `index.html` is an early UI sketch using the same sample numbers. The page is static for now; it does not read the CSV yet.

## Current milestone: choose a CSV file

`main.py` loads the CSV you choose (or `sample_transactions.csv` by default) and reports:

- purchases, which count as spending;
- confirmed refund credits, which reduce net spending;
- transfers, such as paying a credit-card bill, which are not another purchase;
- purchases grouped by a category you enter in the CSV;
- expected refunds, linked credits, and the amount still due for each watched purchase;
- possible links for unlinked refund credits.

The `kind` and purchase `category` columns are entered manually for now. The category breakdown shows purchases before refunds. Refund links are also entered manually. All rows are synthetic; no bank login or personal statement is needed.

## Track a refund

Each transaction has a unique `id`. To watch a purchase, enter the amount you expect back in its `refund_expected` field. Leave this blank for purchases you are not tracking. This can be less than the purchase price if you returned only part of an order.

When a refund credit appears, add it as a separate transaction with `kind` set to `refund` and a positive amount. Set its `refund_for` field to the original purchase's ID after checking that the credit belongs to that purchase. Leave `refund_for` blank if you have not confirmed the link.

In the sample, purchase `t3` expects INR 1,200 back. Credit `t5` links to `t3` and accounts for INR 900, so the watchlist shows **Partly received**, with **INR 300 still due**. Multiple credits can link to the same purchase. The status becomes **Received** once their total reaches the expected amount.

Expected refunds do not reduce net spending. Only actual refund rows do, including credits that have not been linked yet. The watchlist counts only explicitly linked credits. If linked credits exceed the expected amount, the received total shows the full amount and the remaining amount stays at zero.

## Check a suggested link

The script suggests a link only when an unlinked refund and a watched purchase share a useful word in their descriptions, the refund is dated on or after the purchase, and its amount fits within what is still due. It ignores common words like `refund`, `card`, and `online`. This is only a clue: two purchases can both be suggested, and a real refund can have no shared words. Check your statement or order details before putting the purchase ID in `refund_for`.

Try the separate example with `python main.py examples/unlinked_refund.csv`. Purchase `p1` expects INR 1,200 back, and refund `r1` confirms INR 900. The last INR 300 is present as credit `r2`, but it has no confirmed link yet. The script suggests linking `r2` to `p1`. After checking the credit, enter `p1` in `r2`'s `refund_for` field and rerun to see **Received**. Both credits count in total refunds received even before you link them.

## Run

Requires Python 3.10 or newer:

```powershell
python main.py
```

To read another file, pass its path. Put quotes around paths containing spaces:

```powershell
python main.py examples/unlinked_refund.csv
python main.py "D:\statements\october transactions.csv"
python main.py --help
```

Files must use the same columns as `sample_transactions.csv`, UTF-8 text, and dates like `2026-09-05`. Direct bank exports may need their columns converted first. Relative paths start from your terminal's current folder. The script reads the file without changing it and reports missing files or invalid rows as an error.

Open `index.html` in a browser to see the UI sketch.

Run the refund checks with:

```powershell
python -m unittest -v
```

## Planned next steps

1. Let the user correct a suggested category instead of entering every category manually.
2. Connect the browser interface to the calculations once the rules are trustworthy.

I'm adding these pieces one at a time so the calculations stay easy to check.
