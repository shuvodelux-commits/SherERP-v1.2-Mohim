'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createGasEnvironment, mustOk } = require('./helpers/gasHarness');

test('Purchase Landed Cost: prorates by line value into STOCK_LOTS, flows into FIFO COGS, excludes freight from Purchase Return refunds, and balances Balance Sheet', () => {
  const { ctx, token, advanceSeconds } = createGasEnvironment({ nowIso: '2026-11-15T10:00:00+06:00' });
  mustOk(ctx.startCashSession(token, 50000, 'Open'));
  const sup = mustOk(ctx.addSupplier(token, { name: 'Bulk Importer', openingBalance: 0 }));
  const prodA = mustOk(ctx.addProduct(token, { name: 'Pipe A', purchasePrice: 100, sellingPrice: 160, stock: 0, minStock: 1 }));
  const prodB = mustOk(ctx.addProduct(token, { name: 'Pump B', purchasePrice: 200, sellingPrice: 300, stock: 0, minStock: 1 }));

  // Subtotal = 3,000 (1,000 A + 2,000 B), Discount = 300, Landed Cost = 300 -> Grand Total = 3,000 Paid Cash
  // Prorated Landed Cost: A gets +100 (+10/unit -> 110), B gets +200 (+20/unit -> 220)
  const pur = mustOk(ctx.createPurchase(token, {
    supplierId: sup.id, date: '2026-11-15', discount: 300, landedCost: 300, paidAmount: 3000, paymentMethod: 'Cash',
    items: [
      { productId: prodA.id, name: 'Pipe A', qty: 10, unitPrice: 100, sellingPrice: 160 },
      { productId: prodB.id, name: 'Pump B', qty: 10, unitPrice: 200, sellingPrice: 300 }
    ]
  }));
  assert.equal(pur.grandTotal, 3000);
  advanceSeconds(5);

  const lots = ctx.getAllRows_('STOCK_LOTS');
  const lotA = lots.find(l => l['Product ID'] === prodA.id);
  const lotB = lots.find(l => l['Product ID'] === prodB.id);
  assert.equal(Number(lotA['Purchase Price']), 110, 'Item A lot cost must be 100 + 10 landed = 110');
  assert.equal(Number(lotB['Purchase Price']), 220, 'Item B lot cost must be 200 + 20 landed = 220');
  assert.equal(mustOk(ctx.getStockReport(token)).totals.inventoryValue, 3300);
  assert.equal(mustOk(ctx.getBalanceSheetReport(token)).reconciliation.difference, 0);

  // Sell 4 Pipe A @ 160 = 640 Cash -> FIFO COGS must be 4 * 110 = 440
  mustOk(ctx.completeSale(token, {
    customerName: 'Retail 1', customerPhone: '01755550001', paymentType: 'Cash', paymentMethod: 'Cash', discount: 0,
    date: '2026-11-15', items: [{ productId: prodA.id, name: 'Pipe A', qty: 4, unitPrice: 160, priceMode: 'manual' }]
  }));
  advanceSeconds(5);

  let prof = mustOk(ctx.getProfitReport(token, { from: '2026-11-15', to: '2026-11-15' }));
  assert.equal(prof.totals.cogs, 440, 'COGS must include prorated landed cost (4 * 110 = 440)');
  assert.equal(mustOk(ctx.getBalanceSheetReport(token)).reconciliation.difference, 0);

  // Return 2 Pipe A to Supplier (Cash): Supplier refunds net goods price 2 * 90 = 180 (freight 20 is non-refundable)
  const ret = mustOk(ctx.completePurchaseReturn(token, {
    purchaseId: pur.purchaseId, refundMethod: 'Cash', reason: 'Damaged crate', date: '2026-11-15',
    items: [{ productId: prodA.id, name: 'Pipe A', qty: 2 }]
  }));
  assert.equal(ret.totalReturnAmount, 180, 'Supplier refund must be net goods price (2 * 90 = 180), excluding transport');

  prof = mustOk(ctx.getProfitReport(token, { from: '2026-11-15', to: '2026-11-15' }));
  assert.equal(prof.totals.purchaseDiscountIncome, 280, '300 discount - 20 clawed back on returned 2 units');
  assert.equal(prof.totals.returnedPurchaseLandedCost, 20, '20 non-refundable transport written off on returned 2 units');
  assert.equal(prof.totals.netProfit, 460, 'Gross Profit (640-440=200) + Net Discount (280) - Returned Landed Cost (20) = 460');

  const bs = mustOk(ctx.getBalanceSheetReport(token));
  assert.equal(bs.reconciliation.difference, 0, 'Balance Sheet must stay 100% balanced with landed costs + returns');
  assert.equal(bs.reconciliation.balanced, true);
});

test('Purchase Landed Cost: updatePurchase adjusts lot cost while unsold, blocks once sold, and handles Discount=0 returns', () => {
  const { ctx, token, advanceSeconds } = createGasEnvironment({ nowIso: '2026-11-15T10:00:00+06:00' });
  mustOk(ctx.startCashSession(token, 50000, 'Open'));
  const sup = mustOk(ctx.addSupplier(token, { name: 'Local Dist', openingBalance: 0 }));
  const prod = mustOk(ctx.addProduct(token, { name: 'Steel Flange', purchasePrice: 100, sellingPrice: 180, stock: 0, minStock: 1 }));

  // Buy 10 @ 100, Discount = 0, Landed Cost = 100 -> Grand Total = 1,100 Paid Cash -> Lot @ 110
  const pur = mustOk(ctx.createPurchase(token, {
    supplierId: sup.id, date: '2026-11-15', discount: 0, landedCost: 100, paidAmount: 1100, paymentMethod: 'Cash',
    items: [{ productId: prod.id, name: 'Steel Flange', qty: 10, unitPrice: 100, sellingPrice: 180 }]
  }));
  assert.equal(pur.grandTotal, 1100);
  assert.equal(Number(ctx.getAllRows_('STOCK_LOTS')[0]['Purchase Price']), 110);
  advanceSeconds(5);

  // getPurchaseForUpdate exposes landedCost
  const forUpd = mustOk(ctx.getPurchaseForUpdate(token, pur.purchaseId));
  assert.equal(forUpd.landedCost, 100);

  // Edit Landed Cost 100 -> 200 while unsold -> Grand Total 1,200, Lot @ 120
  mustOk(ctx.updatePurchase(token, pur.purchaseId, {
    supplierId: sup.id, discount: 0, landedCost: 200, paidAmount: 1200, paymentMethod: 'Cash', reason: 'Updated truck fare',
    items: [{ productId: prod.id, name: 'Steel Flange', qty: 10, unitPrice: 100, sellingPrice: 180 }]
  }));
  assert.equal(Number(ctx.getAllRows_('STOCK_LOTS')[0]['Purchase Price']), 120);
  assert.equal(mustOk(ctx.getBalanceSheetReport(token)).reconciliation.difference, 0);
  advanceSeconds(5);

  // Sell 1 unit -> now editing landedCost MUST be blocked because lot has sold units
  mustOk(ctx.completeSale(token, {
    customerName: 'Retail 2', customerPhone: '01755550002', paymentType: 'Cash', paymentMethod: 'Cash', discount: 0,
    date: '2026-11-15', items: [{ productId: prod.id, name: 'Steel Flange', qty: 1, unitPrice: 180, priceMode: 'manual' }]
  }));
  const blocked = ctx.updatePurchase(token, pur.purchaseId, {
    supplierId: sup.id, discount: 0, landedCost: 250, paidAmount: 1250, paymentMethod: 'Cash', reason: 'Late fare change',
    items: [{ productId: prod.id, name: 'Steel Flange', qty: 10, unitPrice: 100, sellingPrice: 180 }]
  });
  assert.equal(blocked.success, false, 'Cannot change Landed Cost after stock from the lot has been sold');

  // Return 2 units Cash (Discount=0, Landed Cost=200 -> 20/unit transport lost on returned 2 units = 40)
  const ret = mustOk(ctx.completePurchaseReturn(token, {
    purchaseId: pur.purchaseId, refundMethod: 'Cash', reason: 'Return 2', date: '2026-11-15',
    items: [{ productId: prod.id, name: 'Steel Flange', qty: 2 }]
  }));
  assert.equal(ret.totalReturnAmount, 200);
  const prof = mustOk(ctx.getProfitReport(token, { from: '2026-11-15', to: '2026-11-15' }));
  assert.equal(prof.totals.returnedPurchaseLandedCost, 40);
  assert.equal(prof.totals.netProfit, 20, 'Sale profit (180 - 120 = 60) - 40 non-refundable transport = 20');
  assert.equal(mustOk(ctx.getBalanceSheetReport(token)).reconciliation.difference, 0);
});
