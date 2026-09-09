# Legacy invoice-comparison spreadsheets (archived)

These five `Invoice_Comparison_INV_2026_06_00*.xlsx` files were one-off, per-invoice
exports comparing our rates against outside/market rates. They have been
**superseded by two built-in screens** in the dashboard and are kept here only for
historical reference:

- **Price Analysis** (`Price Analysis` tab) — consolidated, always-current
  per-item comparison of our price vs market mid, margin %, gross profit,
  customer savings vs market, and a monthly trend. Export from the screen for a
  single, live `Price_Analysis.xlsx`.
- **Invoice Comparison** (`Invoice Comparison` tab) — the per-invoice tax & cost
  comparison these files originally captured, generated on demand from live data.

Because both screens read directly from the database, they never go stale the way
these static snapshots did (the snapshots were exported before market prices were
loaded, so their "Outside Rate" columns are all 0).
