# Stock lot fix: oversold cost, settlement, returns, POS cost

Replace these 13 files in the Apps Script project:
StockLots.js, Purchase.js, PurchaseManagement.js, Sales.js, Products.js, products.html, pos.html, Reports.js,
Config.js, DeleteEngine.js, Vendors.js, SalesManagement.js

## What changed
1. Oversold lot cost = latest real lot's cost (latestKnownLotCost_), not Products."Purchase Price".
2. Stock coming IN (purchase, purchase edit that adds qty, manual stock increase, return)
   goes through createInboundLot_ / settleOversoldLots_:
   - pays off the oldest oversold lots first
   - re-costs those lots AND their Sale Item Lots "Unit Cost" (COGS) to the incoming cost
   - the new lot keeps full Original Quantity; only Remaining is reduced
3. Purchase.js: Products."Purchase Price" follows the latest (non-backdated) purchase.
4. Sales return:
   - against an oversold lot that is still negative: repays that lot (no new lot)
   - otherwise: new lot at the sale line's own Unit Cost (not the product field)
   - return undo may take an OVERSOLD lot back below zero
   - this also fixes the sale-delete path (restoreStockToLots_), which left the -1 stale lots
5. POS eye icon (Sales.js getPosBootstrap + pos.html posLineCost_): shows the CURRENT lot's price (next FIFO lot).
   A line with a shortage (stock <= 0, or qty above available: negative-stock / vendor sale) shows the latest
   purchase lot cost instead. No blending. "Latest" = newest PUR-/ADJUSTMENT/OPENING lot, ignoring
   returned-stock and oversold lots.
6. Product table: Products.js sends "Lot Purchase Price" (next FIFO lot cost, else latest lot cost);
   products.html shows and sorts the Purchase column by it. The stored "Purchase Price" is untouched
   and still used by the edit form. Stock Value was already lot based.
7. Stock report (Reports.js getStockReport): Purchase column = current lot cost, same rule.
8. One-time repair for existing data:
   - previewOversoldLotRepair(token)  read-only list of every change
   - applyOversoldLotRepair(token)    writes exactly that
   Current Stock is never changed; each product's lot total stays equal to it.

## Product > View Lots (new)
- StockLots.js getProductLotsView(): lots + the FULL stock movement history of every type for the product
  (Purchase, Sale, Sales Return, Adjustment, Opening Stock, Sale/Purchase Deleted, Vendor movements, ...), plus canEditPrice.
- StockLots.js updateStockLotSellPrice(): saves one lot's sale price (products > edit permission, locked, validated,
  only lots that still hold stock, audit line in the Logs sheet). POS reads lot sale prices, so future sales use it.
  It never changes past invoices, stock quantity or purchase cost.
- products.html: View Lots shows Sale Price per lot with an inline editor + Save, a "Selling now" marker on the lot POS
  sells next, a below-cost confirmation, and a Stock Movement table (newest first) with Type and Lot filters;
  clicking a Lot ID filters the movements to that lot.

## Gaps from the first review, now covered
- Vendor issue/return reversal lots (DeleteEngine.js x5, Vendors.js x1) use createInboundLot_: they pay off oversold debt.
- Invoice edit that moves stock to vendor sourcing (SalesManagement.js restoreSaleStockEffectForVendorSourcing_):
  leftover stock goes back at the sale line's Unit Cost (not the product field) and pays off oversold debt.
- Purchase edit / delete after settlement (PurchaseManagement.js, DeleteEngine.js deletePurchase):
  each inbound lot records the oversold debt it paid off in a new STOCK_LOTS column "Settlement Log"
  (added automatically to the live sheet). Reducing or deleting the purchase re-opens exactly that debt
  (oversold lot goes back below zero at its earlier provisional cost, and its sales are re-costed back).
  Only stock that was truly sold to customers still blocks the edit/delete. A price edit re-costs the
  oversold lots that purchase settled. adjustProductStock_ got an optional allowNegative flag for this.
- The repair (applyOversoldLotRepair) also writes Settlement Log entries, so repaired lots behave the same way.
- POS profit for negative lines uses the latest lot cost (your rule) - no code change needed.

## Still not covered
- Purchase RETURN (to supplier) of quantity that paid off oversold debt is still blocked as "sold".
- SalesManagement.js legacy seeding (~line 928) still uses the product's stored Purchase Price for invoices that have no lot evidence.
- Everything was tested in a Node simulation of the sheets, not in Apps Script itself.
