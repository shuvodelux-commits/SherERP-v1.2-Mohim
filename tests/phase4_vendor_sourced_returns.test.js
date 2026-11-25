'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createGasEnvironment, mustOk } = require('./helpers/gasHarness');

test('Vendor-Sourced Sale Returns (Sellable): restores own lots + absorbs vendor units at vendor cost, keeps Profit & Balance Sheet balanced', () => {
  const { ctx, token, advanceSeconds } = createGasEnvironment({ nowIso: '2026-11-15T10:00:00+06:00' });
  mustOk(ctx.startCashSession(token, 10000, 'Open'));
  const vendor = mustOk(ctx.addVendor(token, { name: 'V-Source', phone: '01777770001' }));
  const prod = mustOk(ctx.addProduct(token, { name: 'Motor Valve', purchasePrice: 100, sellingPrice: 160, stock: 2, minStock: 1 }));

  // Sell 5 @ 160 = 800 Cash: 2 own @ 100 + 3 vendor @ 130
  const sale = mustOk(ctx.completeSale(token, {
    customerName: 'Kamal', customerPhone: '01711112222', paymentType: 'Cash', paymentMethod: 'Cash', discount: 0,
    date: '2026-11-15',
    items: [{ productId: prod.id, name: 'Motor Valve', qty: 5, unitPrice: 160, priceMode: 'manual', vendorId: vendor.id, vendorUnitCost: 130 }]
  }));
  advanceSeconds(5);

  // getInvoiceForReturn must allow returning ALL 5 sold units (including 3 vendor-sourced)
  const forRet = mustOk(ctx.getInvoiceForReturn(token, sale.invoiceId));
  assert.equal(forRet.items[0].availableQty, 5, 'All 5 sold units (own + vendor-sourced) must be returnable');
  assert.equal(forRet.items[0].vendorSourcedQty, 3);

  // Return 4 Sellable units @ 160 = 640 Cash (2 unwind own LOT-1 @ 100 + 2 absorb vendor units @ 130)
  mustOk(ctx.completeReturn(token, {
    invoiceId: sale.invoiceId, refundMethod: 'Cash', reason: 'Excess order', date: '2026-11-15',
    items: [{ productId: prod.id, name: 'Motor Valve', qty: 4, condition: 'Sellable' }]
  }));
  advanceSeconds(5);

  assert.equal(ctx.getAllRows_('PRODUCTS').find(p => p['Product ID'] === prod.id)['Current Stock'], 4);
  assert.equal(mustOk(ctx.getStockReport(token)).totals.inventoryValue, 460, '2 @ 100 + 2 @ 130 = 460');

  // Profit Report: 1 remaining vendor unit sold -> Revenue 160, COGS 130, Net Profit 30, 0 missing lot coverage
  const prof = mustOk(ctx.getProfitReport(token, { from: '2026-11-15', to: '2026-11-15' }));
  assert.equal(prof.totals.netRevenue, 160);
  assert.equal(prof.totals.cogs, 130);
  assert.equal(prof.totals.netProfit, 30);
  assert.equal(prof.coverage.invoicesMissingLotData, 0);

  // Balance Sheet must reconcile to 0.00 (Vendor Payable still 390 until returned/paid to vendor)
  let bs = mustOk(ctx.getBalanceSheetReport(token));
  assert.equal(bs.assets.inventory, 460);
  assert.equal(bs.liabilities.vendorPayable, 390);
  assert.equal(bs.reconciliation.difference, 0);
  assert.equal(bs.reconciliation.balanced, true);

  // Now return 2 units back to Vendor at vendor cost (130) -> Vendor Payable drops to 130, Balance Sheet still balanced
  const sourcing = ctx.activeRows_('VENDOR_SOURCING')[0];
  mustOk(ctx.returnProductsToVendor(token, {
    vendorId: vendor.id, sourcingId: sourcing['Sourcing ID'], quantity: 2, date: '2026-11-15', notes: 'Send back'
  }));
  bs = mustOk(ctx.getBalanceSheetReport(token));
  assert.equal(bs.liabilities.vendorPayable, 130);
  assert.equal(bs.reconciliation.difference, 0);
});

test('Vendor-Sourced Sale Returns (Damaged + Sellable + deleteSalesReturn): preserves COGS loss on Damaged and cleanly reverses Sellable on delete', () => {
  const { ctx, token, advanceSeconds } = createGasEnvironment({ nowIso: '2026-11-15T10:00:00+06:00' });
  mustOk(ctx.startCashSession(token, 10000, 'Open'));
  const vendor = mustOk(ctx.addVendor(token, { name: 'V-Source 2', phone: '01777770002' }));
  const prod = mustOk(ctx.addProduct(token, { name: 'Check Elbow', purchasePrice: 100, sellingPrice: 160, stock: 0, minStock: 1 }));

  // Pure vendor-sourced sale: 3 @ 160 = 480 Cash, vendor cost 3 @ 130 = 390
  const sale = mustOk(ctx.completeSale(token, {
    customerName: 'Jamal', customerPhone: '01711113333', paymentType: 'Cash', paymentMethod: 'Cash', discount: 0,
    date: '2026-11-15',
    items: [{ productId: prod.id, name: 'Check Elbow', qty: 3, unitPrice: 160, priceMode: 'manual', vendorId: vendor.id, vendorUnitCost: 130 }]
  }));
  advanceSeconds(5);

  // Return 1 Damaged unit @ 160 -> no stock added, COGS stays 390, Net Profit = 320 - 390 = -70
  mustOk(ctx.completeReturn(token, {
    invoiceId: sale.invoiceId, refundMethod: 'Cash', reason: 'Broken', date: '2026-11-15',
    items: [{ productId: prod.id, name: 'Check Elbow', qty: 1, condition: 'Damaged' }]
  }));
  advanceSeconds(5);

  assert.equal(ctx.getAllRows_('PRODUCTS').find(p => p['Product ID'] === prod.id)['Current Stock'], 0);
  let prof = mustOk(ctx.getProfitReport(token, { from: '2026-11-15', to: '2026-11-15' }));
  assert.equal(prof.totals.netRevenue, 320);
  assert.equal(prof.totals.cogs, 390);
  assert.equal(prof.totals.netProfit, -70);
  assert.equal(mustOk(ctx.getBalanceSheetReport(token)).reconciliation.difference, 0);

  // Return remaining 2 units as Sellable -> absorbed into stock @ 130 (Inventory = 260, COGS = 130, Net Profit = -130)
  const retSellable = mustOk(ctx.completeReturn(token, {
    invoiceId: sale.invoiceId, refundMethod: 'Cash', reason: 'Unused', date: '2026-11-15',
    items: [{ productId: prod.id, name: 'Check Elbow', qty: 2, condition: 'Sellable' }]
  }));
  advanceSeconds(5);

  assert.equal(ctx.getAllRows_('PRODUCTS').find(p => p['Product ID'] === prod.id)['Current Stock'], 2);
  assert.equal(mustOk(ctx.getStockReport(token)).totals.inventoryValue, 260);
  prof = mustOk(ctx.getProfitReport(token, { from: '2026-11-15', to: '2026-11-15' }));
  assert.equal(prof.totals.netRevenue, 0);
  assert.equal(prof.totals.cogs, 130);
  assert.equal(prof.totals.netProfit, -130);
  assert.equal(mustOk(ctx.getBalanceSheetReport(token)).reconciliation.difference, 0);

  // Delete the 2-unit Sellable return -> stock back to 0, COGS back to 390, Balance Sheet balanced
  mustOk(ctx.deleteSalesReturn(token, retSellable.returnId, 'Mistake', 'op-del-vendor-ret-001'));
  assert.equal(ctx.getAllRows_('PRODUCTS').find(p => p['Product ID'] === prod.id)['Current Stock'], 0);
  assert.equal(mustOk(ctx.getStockReport(token)).totals.inventoryValue, 0);
  prof = mustOk(ctx.getProfitReport(token, { from: '2026-11-15', to: '2026-11-15' }));
  assert.equal(prof.totals.netRevenue, 320);
  assert.equal(prof.totals.cogs, 390);
  assert.equal(mustOk(ctx.getBalanceSheetReport(token)).reconciliation.difference, 0);
});
