# MoneyTrail

I use UPI and a credit card, and it can be hard to see where small spends went or whether a refund actually came back. MoneyTrail is a small project I'm building around those two questions.

The project will grow in small steps. The Python script reads a simple CSV of sample transactions and calculates spending. `index.html` is an early UI sketch using the same sample numbers. The page is static for now; it does not read the CSV yet.

## Current milestone: refund watchlist

`main.py` loads `sample_transactions.csv` and reports:

- purchases, which count as spending;
- confirmed refund credits, which reduce net spending;
- transfers, such as paying a credit-card bill, which are not another purchase;
- purchases grouped by a category you enter in the CSV;
- expected refunds, linked credits, and the amount still due for each watched purchase.

The `kind` and purchase `category` columns are entered manually for now. The category breakdown shows purchases before refunds. Refund links are also entered manually; there is no automatic matching yet. All rows are synthetic; no bank login or personal statement is needed.

## Track a refund

Each transaction has a unique `id`. To watch a purchase, enter the amount you expect back in its `refund_expected` field. Leave this blank for purchases you are not tracking. This can be less than the purchase price if you returned only part of an order.

When a refund credit appears, add it as a separate transaction with `kind` set to `refund` and a positive amount. Set its `refund_for` field to the original purchase's ID after checking that the credit belongs to that purchase. Leave `refund_for` blank if you have not confirmed the link.

In the sample, purchase `t3` expects INR 1,200 back. Credit `t5` links to `t3` and accounts for INR 900, so the watchlist shows **Partly received**, with **INR 300 still due**. Multiple credits can link to the same purchase. The status becomes **Received** once their total reaches the expected amount.

Expected refunds do not reduce net spending. Only actual refund rows do, including credits that have not been linked yet. The watchlist counts only explicitly linked credits. If linked credits exceed the expected amount, the received total shows the full amount and the remaining amount stays at zero.

## Run

Requires Python 3.10 or newer:

```powershell
python main.py
```

Open `index.html` in a browser to see the UI sketch.

Run the refund checks with:

```powershell
python -m unittest -v
```

## Planned next steps

1. Let the user correct a suggested category instead of entering every category manually.
2. Suggest possible refund credits from a later statement; require user confirmation.
3. Connect the browser interface to the calculations once the rules are trustworthy.

I'm adding these pieces one at a time so the calculations stay easy to check.
