# MoneyTrail

I use UPI and a credit card, and it can be hard to see where small spends went or whether a refund actually came back. MoneyTrail is a small project I'm building around those two questions.

The project will grow in small steps. The Python script reads a simple CSV of sample transactions and calculates spending. `index.html` is an early UI sketch using the same sample numbers. The page is static for now; it does not read the CSV yet.

## Current milestone: spending categories

`main.py` loads `sample_transactions.csv` and reports:

- purchases, which count as spending;
- confirmed refund credits, which reduce net spending;
- transfers, such as paying a credit-card bill, which are not another purchase;
- purchases grouped by a category you enter in the CSV.

The `kind` and purchase `category` columns are entered manually for now. The category breakdown shows purchases before refunds. Refunds are not assigned to categories until they can be matched to a purchase. This makes the calculation easy to verify before adding any automatic classification. All rows are synthetic; no bank login or personal statement is needed.

## Run

Requires Python 3.10 or newer:

```powershell
python main.py
```

Open `index.html` in a browser to see the UI sketch.

## Planned next steps

1. Let the user correct a suggested category instead of entering every category manually.
2. Let the user mark a purchase as waiting for a refund.
3. Suggest possible refund credits from a later statement; require user confirmation.
4. Connect the browser interface to the calculations once the rules are trustworthy.

I'm adding these pieces one at a time so the calculations stay easy to check.
