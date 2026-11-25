'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createGasEnvironment, mustOk } = require('./helpers/gasHarness');

test('Baseline FIFO: multi-lot partial consumption & depleted lot Status -> Consumed (BUG-25)', () => {
  const { ctx, token, advanceSeconds } = createGasEnvironment({ nowIso: '2026-11-10T09:00:00+06:00' });
  mustOk(ctx.startCashSession(token, 100000, 'Open'));
  const sup = mustOk(ctx.addSupplier(token, { name: 'Sup A', openingBalance: 0 }));
  const prod = mustOk(ctx.addProduct(token, { name: 'Cement', purchasePrice: 500, sellingPrice: 600, stock: 0, minStock: 5 }));

  mustOk(ctx.createPurchase(token, {
    supplierId: sup.id, date: '2026-11-10', discount: 0, paidAmount: 5000, paymentMethod: 'Cash',
    items: [{ productId: prod.id, name: 'Cement', qty: 10, unitPrice: 500, sellingPrice: 600 }]
  }));
  advanceSeconds(5);
  mustOk(ctx.createPurchase(token, {
    supplierId: sup.id, date: '2026-11-10', discount: 0, paidAmount: 5500, paymentMethod: 'Cash',
    items: [{ productId: prod.id, name: 'Cement', qty: 10, unitPrice: 550, sellingPrice: 650 }]
  }));

  mustOk(ctx.completeSale(token, {
    customerName: 'Cust 1', customerPhone: '01711111111', paymentType: 'Cash', paymentMethod: 'Cash', discount: 0,
    date: '2026-11-10',
    items: [{ productId: prod.id, name: 'Cement', qty: 14, unitPrice: 620, priceMode: 'manual' }]
  }));

  const lots = ctx.getAllRows_('STOCK_LOTS');
  assert.equal(lots[0]['Remaining Quantity'], 0);
  assert.equal(lots[0]['Status'], 'Consumed', 'Fully depleted lot must transition to Consumed');
  assert.equal(lots[1]['Remaining Quantity'], 6);
  assert.equal(lots[1]['Status'], 'Active');

  const profit = mustOk(ctx.getProfitReport(token, { from: '2026-11-01', to: '2026-11-30' }));
  assert.equal(profit.totals.cogs, 7200);
  assert.equal(profit.totals.grossProfit, 1480);
});

test('BUG-01: createPurchase settles earlier negative-stock OVERSOLD lot, recosts COGS, updates Purchase Price, and prevents phantom sales', () => {
  const { ctx, token, advanceSeconds } = createGasEnvironment({ nowIso: '2026-11-10T09:00:00+06:00' });
  mustOk(ctx.startCashSession(token, 100000, 'Open'));
  const sup = mustOk(ctx.addSupplier(token, { name: 'Sup A', openingBalance: 0 }));
  const prod = mustOk(ctx.addProduct(token, { name: 'Pipe', purchasePrice: 100, sellingPrice: 150, stock: 0, minStock: 2 }));

  // Sale 1: sell 5 units from 0 stock -> OVERSOLD -5 @ provisional 100
  mustOk(ctx.completeSale(token, {
    customerName: 'Cust 1', customerPhone: '01711111111', paymentType: 'Cash', paymentMethod: 'Cash', discount: 0,
    date: '2026-11-10',
    items: [{ productId: prod.id, name: 'Pipe', qty: 5, unitPrice: 150, priceMode: 'manual' }]
  }));
  advanceSeconds(10);

  // Purchase 1: buy 10 units @ 120 via createPurchase
  mustOk(ctx.createPurchase(token, {
    supplierId: sup.id, date: '2026-11-10', discount: 0, paidAmount: 1200, paymentMethod: 'Cash',
    items: [{ productId: prod.id, name: 'Pipe', qty: 10, unitPrice: 120, sellingPrice: 160 }]
  }));

  const prodRow = ctx.getAllRows_('PRODUCTS')[0];
  assert.equal(prodRow['Current Stock'], 5);
  assert.equal(prodRow['Purchase Price'], 120, 'PRODUCTS.Purchase Price must follow latest purchase');

  const lotsAfterPur = ctx.getAllRows_('STOCK_LOTS');
  assert.equal(lotsAfterPur[0]['Remaining Quantity'], 0, 'OVERSOLD lot must be settled to 0');
  assert.equal(lotsAfterPur[0]['Status'], 'Settled');
  assert.equal(lotsAfterPur[1]['Remaining Quantity'], 5, 'New purchase lot must retain only 5 remaining after settling 5 oversold');

  const profit = mustOk(ctx.getProfitReport(token, { from: '2026-11-01', to: '2026-11-30' }));
  assert.equal(profit.totals.cogs, 600, 'Sale 1 COGS must be recosted to 5 * 120 = 600');
  assert.equal(profit.totals.grossProfit, 150, 'Sale 1 Gross Profit must be 750 - 600 = 150');

  const stockRep = mustOk(ctx.getStockReport(token));
  assert.equal(stockRep.totals.inventoryValue, 600);
  assert.equal(stockRep.products[0].lotMismatch, false);

  const bs = mustOk(ctx.getBalanceSheetReport(token));
  assert.equal(bs.assets.inventory, 600);

  // Sale 2: sell 8 units -> must consume only the 5 real units from LOT-2 and create a -3 OVERSOLD lot
  advanceSeconds(10);
  mustOk(ctx.completeSale(token, {
    customerName: 'Cust 2', customerPhone: '01722222222', paymentType: 'Cash', paymentMethod: 'Cash', discount: 0,
    date: '2026-11-10',
    items: [{ productId: prod.id, name: 'Pipe', qty: 8, unitPrice: 160, priceMode: 'manual' }]
  }));

  const lotsAfterSale2 = ctx.getAllRows_('STOCK_LOTS');
  assert.equal(ctx.getAllRows_('PRODUCTS')[0]['Current Stock'], -3);
  assert.equal(lotsAfterSale2[1]['Remaining Quantity'], 0, 'Purchase lot must be fully exhausted');
  assert.equal(lotsAfterSale2.length, 3, 'New OVERSOLD lot must be created for the 3-unit shortfall');
  assert.equal(lotsAfterSale2[2]['Purchase ID'], 'OVERSOLD');
  assert.equal(lotsAfterSale2[2]['Remaining Quantity'], -3);
});

test('BUG-02: Single negative sale (10u) settled across 2 purchases (4@120, 6@150) preserves exact split COGS (1380, not 1500)', () => {
  const { ctx, token, advanceSeconds } = createGasEnvironment({ nowIso: '2026-11-10T09:00:00+06:00' });
  mustOk(ctx.startCashSession(token, 100000, 'Open'));
  const sup = mustOk(ctx.addSupplier(token, { name: 'Sup A', openingBalance: 0 }));
  const prod = mustOk(ctx.addProduct(token, { name: 'Valve', purchasePrice: 100, sellingPrice: 200, stock: 0, minStock: 1 }));

  mustOk(ctx.completeSale(token, {
    customerName: 'Cust 1', customerPhone: '01711111111', paymentType: 'Cash', paymentMethod: 'Cash', discount: 0,
    date: '2026-11-10',
    items: [{ productId: prod.id, name: 'Valve', qty: 10, unitPrice: 200, priceMode: 'manual' }]
  }));
  advanceSeconds(5);

  // Purchase 1: 4 @ 120
  const pur1 = mustOk(ctx.createPurchase(token, {
    supplierId: sup.id, date: '2026-11-10', discount: 0, paidAmount: 480, paymentMethod: 'Cash',
    items: [{ productId: prod.id, name: 'Valve', qty: 4, unitPrice: 120, sellingPrice: 200 }]
  }));
  const p1 = mustOk(ctx.getProfitReport(token, { from: '2026-11-01', to: '2026-11-30' }));
  assert.equal(p1.totals.cogs, 4 * 120 + 6 * 100, 'After 4@120 settled, COGS must be 4*120 + 6*100 = 1080');

  advanceSeconds(5);
  // Purchase 2: 6 @ 150
  const pur2 = mustOk(ctx.createPurchase(token, {
    supplierId: sup.id, date: '2026-11-10', discount: 0, paidAmount: 900, paymentMethod: 'Cash',
    items: [{ productId: prod.id, name: 'Valve', qty: 6, unitPrice: 150, sellingPrice: 200 }]
  }));
  const p2 = mustOk(ctx.getProfitReport(token, { from: '2026-11-01', to: '2026-11-30' }));
  assert.equal(p2.totals.cogs, 4 * 120 + 6 * 150, 'After 6@150 settled, COGS must be 4*120 + 6*150 = 1380');
  assert.equal(p2.totals.grossProfit, 2000 - 1380, 'Gross profit must be 620');

  // Price edit on Purchase 1 (120 -> 130) must ONLY recost Purchase 1's 4 units, not Purchase 2's 6 units!
  advanceSeconds(5);
  mustOk(ctx.updatePurchase(token, pur1.purchaseId, {
    supplierId: sup.id, discount: 0, paidAmount: 520, paymentMethod: 'Cash', reason: 'Invoice price fix',
    items: [{ productId: prod.id, name: 'Valve', qty: 4, unitPrice: 130, sellingPrice: 200 }]
  }));
  const p3 = mustOk(ctx.getProfitReport(token, { from: '2026-11-01', to: '2026-11-30' }));
  assert.equal(p3.totals.cogs, 4 * 130 + 6 * 150, 'Editing Purchase 1 price must only recost its 4 settled units (1420)');

  // Deleting Purchase 2 (6 @ 150) must reopen only 6 units back to provisional 100, keeping Purchase 1's 4 @ 130!
  advanceSeconds(5);
  mustOk(ctx.deletePurchase(token, pur2.purchaseId, 'Wrong bill'));
  const p4 = mustOk(ctx.getProfitReport(token, { from: '2026-11-01', to: '2026-11-30' }));
  assert.equal(p4.totals.cogs, 4 * 130 + 6 * 100, 'Deleting Purchase 2 must reopen 6u to 100 while preserving 4u @ 130 (1120)');
  assert.equal(ctx.getAllRows_('PRODUCTS')[0]['Current Stock'], -6);
});

test('BUG-02 (Multi-Sale): 2 negative sales (4u, 6u) settled by 2 purchases (7@120, 5@150) -> exact FIFO COGS 1290', () => {
  const { ctx, token, advanceSeconds } = createGasEnvironment({ nowIso: '2026-11-10T09:00:00+06:00' });
  mustOk(ctx.startCashSession(token, 100000, 'Open'));
  const sup = mustOk(ctx.addSupplier(token, { name: 'Sup A', openingBalance: 0 }));
  const prod = mustOk(ctx.addProduct(token, { name: 'Tee', purchasePrice: 100, sellingPrice: 200, stock: 0, minStock: 1 }));

  mustOk(ctx.completeSale(token, {
    customerName: 'C1', customerPhone: '01711111111', paymentType: 'Cash', paymentMethod: 'Cash', discount: 0,
    date: '2026-11-10', items: [{ productId: prod.id, name: 'Tee', qty: 4, unitPrice: 200, priceMode: 'manual' }]
  }));
  advanceSeconds(5);
  mustOk(ctx.completeSale(token, {
    customerName: 'C2', customerPhone: '01722222222', paymentType: 'Cash', paymentMethod: 'Cash', discount: 0,
    date: '2026-11-10', items: [{ productId: prod.id, name: 'Tee', qty: 6, unitPrice: 200, priceMode: 'manual' }]
  }));
  advanceSeconds(5);
  mustOk(ctx.createPurchase(token, {
    supplierId: sup.id, date: '2026-11-10', discount: 0, paidAmount: 840, paymentMethod: 'Cash',
    items: [{ productId: prod.id, name: 'Tee', qty: 7, unitPrice: 120, sellingPrice: 200 }]
  }));
  advanceSeconds(5);
  mustOk(ctx.createPurchase(token, {
    supplierId: sup.id, date: '2026-11-10', discount: 0, paidAmount: 750, paymentMethod: 'Cash',
    items: [{ productId: prod.id, name: 'Tee', qty: 5, unitPrice: 150, sellingPrice: 200 }]
  }));

  const profit = mustOk(ctx.getProfitReport(token, { from: '2026-11-01', to: '2026-11-30' }));
  // Sale 1: 4@120 = 480; Sale 2: 3@120 + 3@150 = 810; Total COGS = 1290
  assert.equal(profit.totals.cogs, 1290);
  const stockRep = mustOk(ctx.getStockReport(token));
  assert.equal(stockRep.totals.inventoryValue, 2 * 150, 'Remaining 2 units must be valued at 150 each = 300');
});

test('BUG-06: Sales Return while unrelated OVERSOLD lot exists settles debt instead of leaving +2 and -3 side by side', () => {
  const { ctx, token, advanceSeconds } = createGasEnvironment({ nowIso: '2026-11-10T09:00:00+06:00' });
  mustOk(ctx.startCashSession(token, 100000, 'Open'));
  const sup = mustOk(ctx.addSupplier(token, { name: 'Sup A', openingBalance: 0 }));
  const prod = mustOk(ctx.addProduct(token, { name: 'Tap', purchasePrice: 100, sellingPrice: 150, stock: 0, minStock: 1 }));

  mustOk(ctx.createPurchase(token, {
    supplierId: sup.id, date: '2026-11-10', discount: 0, paidAmount: 500, paymentMethod: 'Cash',
    items: [{ productId: prod.id, name: 'Tap', qty: 5, unitPrice: 100, sellingPrice: 150 }]
  }));
  advanceSeconds(5);
  const inv1 = mustOk(ctx.completeSale(token, {
    customerName: 'C1', customerPhone: '01711111111', paymentType: 'Cash', paymentMethod: 'Cash', discount: 0,
    date: '2026-11-10', items: [{ productId: prod.id, name: 'Tap', qty: 5, unitPrice: 150, priceMode: 'manual' }]
  }));
  advanceSeconds(5);
  mustOk(ctx.completeSale(token, {
    customerName: 'C2', customerPhone: '01722222222', paymentType: 'Cash', paymentMethod: 'Cash', discount: 0,
    date: '2026-11-10', items: [{ productId: prod.id, name: 'Tap', qty: 3, unitPrice: 150, priceMode: 'manual' }]
  }));
  advanceSeconds(5);

  const ret = mustOk(ctx.completeReturn(token, {
    invoiceId: inv1.invoiceId, refundMethod: 'Cash', reason: 'Unused', date: '2026-11-10',
    items: [{ productId: prod.id, name: 'Tap', qty: 2 }]
  }));

  const lots = ctx.getAllRows_('STOCK_LOTS').filter(l => l['Status'] !== 'Deleted');
  const positiveLots = lots.filter(l => (Number(l['Remaining Quantity']) || 0) > 0);
  const negativeLots = lots.filter(l => (Number(l['Remaining Quantity']) || 0) < 0);
  assert.equal(ctx.getAllRows_('PRODUCTS')[0]['Current Stock'], -1);
  assert.equal(positiveLots.length, 0, 'Must not have positive lots coexisting with negative OVERSOLD lots');
  assert.equal(negativeLots.reduce((s, l) => s + Number(l['Remaining Quantity']), 0), -1);

  // Undoing that return must cleanly reopen the oversold lot back to -3
  mustOk(ctx.deleteSalesReturn(token, ret.returnId, 'Undo test', 'op-undo-ret-00001'));
  assert.equal(ctx.getAllRows_('PRODUCTS')[0]['Current Stock'], -3);
  const lotsAfterUndo = ctx.getAllRows_('STOCK_LOTS').filter(l => l['Status'] !== 'Deleted');
  assert.equal(lotsAfterUndo.reduce((s, l) => s + Number(l['Remaining Quantity']), 0), -3);
});

test('BUG-11: Deleting a Sales Return against negative stock succeeds and restores oversold balance', () => {
  const { ctx, token, advanceSeconds } = createGasEnvironment({ nowIso: '2026-11-10T09:00:00+06:00' });
  mustOk(ctx.startCashSession(token, 100000, 'Open'));
  const prod = mustOk(ctx.addProduct(token, { name: 'Nut', purchasePrice: 50, sellingPrice: 80, stock: 0, minStock: 1 }));

  const inv1 = mustOk(ctx.completeSale(token, {
    customerName: 'C1', customerPhone: '01711111111', paymentType: 'Cash', paymentMethod: 'Cash', discount: 0,
    date: '2026-11-10', items: [{ productId: prod.id, name: 'Nut', qty: 5, unitPrice: 80, priceMode: 'manual' }]
  }));
  advanceSeconds(5);

  const ret = mustOk(ctx.completeReturn(token, {
    invoiceId: inv1.invoiceId, refundMethod: 'Cash', reason: 'Wrong item', date: '2026-11-10',
    items: [{ productId: prod.id, name: 'Nut', qty: 2 }]
  }));
  assert.equal(ctx.getAllRows_('PRODUCTS')[0]['Current Stock'], -3);

  mustOk(ctx.deleteSalesReturn(token, ret.returnId, 'Mistake entry', 'op-del-return-0001'));
  assert.equal(ctx.getAllRows_('PRODUCTS')[0]['Current Stock'], -5);
  assert.equal(ctx.getAllRows_('STOCK_LOTS')[0]['Remaining Quantity'], -5);
  assert.equal(ctx.getAllRows_('SALE_ITEM_LOTS')[0]['Quantity'], 5);
});

test('BUG-08: Deleting a settled oversold sale then deleting its settling purchase leaves 0 stock and 0 lots (no zombie -5/+5)', () => {
  const { ctx, token, advanceSeconds } = createGasEnvironment({ nowIso: '2026-11-10T09:00:00+06:00' });
  mustOk(ctx.startCashSession(token, 100000, 'Open'));
  const sup = mustOk(ctx.addSupplier(token, { name: 'Sup A', openingBalance: 0 }));
  const prod = mustOk(ctx.addProduct(token, { name: 'Elbow', purchasePrice: 100, sellingPrice: 150, stock: 0, minStock: 1 }));

  const inv1 = mustOk(ctx.completeSale(token, {
    customerName: 'C1', customerPhone: '01711111111', paymentType: 'Cash', paymentMethod: 'Cash', discount: 0,
    date: '2026-11-10', items: [{ productId: prod.id, name: 'Elbow', qty: 5, unitPrice: 150, priceMode: 'manual' }]
  }));
  advanceSeconds(5);

  const pur = mustOk(ctx.createPurchase(token, {
    supplierId: sup.id, date: '2026-11-10', discount: 0, paidAmount: 1200, paymentMethod: 'Cash',
    items: [{ productId: prod.id, name: 'Elbow', qty: 10, unitPrice: 120, sellingPrice: 160 }]
  }));
  advanceSeconds(5);

  const lotsAfterPur = ctx.getAllRows_('STOCK_LOTS');
  const oversoldAfterPur = lotsAfterPur.find(l => l['Purchase ID'] === 'OVERSOLD');
  const purLotAfterPur = lotsAfterPur.find(l => l['Purchase ID'] === pur.purchaseId);
  assert.equal(oversoldAfterPur['Remaining Quantity'], 0, 'Purchase must settle oversold lot first');
  assert.ok(String(purLotAfterPur['Settlement Log'] || '').includes(oversoldAfterPur['Lot ID']), 'Purchase lot must log settlement before sale delete');

  mustOk(ctx.deleteSalesInvoice(token, inv1.invoiceId, 'Cancelled'));
  assert.equal(ctx.getAllRows_('PRODUCTS')[0]['Current Stock'], 10);

  mustOk(ctx.deletePurchase(token, pur.purchaseId, 'Wrong purchase'));
  assert.equal(ctx.getAllRows_('PRODUCTS')[0]['Current Stock'], 0);

  const activeLots = ctx.getAllRows_('STOCK_LOTS').filter(l => l['Status'] !== 'Deleted');
  const nonZeroLots = activeLots.filter(l => (Number(l['Remaining Quantity']) || 0) !== 0);
  assert.equal(nonZeroLots.length, 0, 'No positive or negative zombie lots may remain when stock is 0');
  const stockRep = mustOk(ctx.getStockReport(token));
  assert.equal(stockRep.totals.inventoryValue, 0);
});

test('BUG-19: Backdated negative-stock sale stamps OVERSOLD lot Purchase Date with sale dateStr (not today)', () => {
  const { ctx, token } = createGasEnvironment({ nowIso: '2026-11-24T12:00:00+06:00' });
  mustOk(ctx.startCashSession(token, 10000, 'Open'));
  const prod = mustOk(ctx.addProduct(token, { name: 'Cable', purchasePrice: 100, sellingPrice: 150, stock: 0, minStock: 1 }));

  mustOk(ctx.completeSale(token, {
    customerName: 'Cust D', customerPhone: '01744444444', paymentType: 'Due', discount: 0,
    date: '2026-11-10', backdatedReason: 'Late entry',
    items: [{ productId: prod.id, name: 'Cable', qty: 3, unitPrice: 150, priceMode: 'manual' }]
  }));

  const lot = ctx.getAllRows_('STOCK_LOTS')[0];
  assert.equal(ctx.safeDateOnly_(lot['Purchase Date']), '2026-11-10');
});

test('Decision #5 (Intentional behavior): Cash refund is allowed on a fully unpaid Due invoice and leaves customer due unchanged', () => {
  const { ctx, token, advanceSeconds } = createGasEnvironment({ nowIso: '2026-11-10T09:00:00+06:00' });
  mustOk(ctx.startCashSession(token, 10000, 'Open'));
  const prod = mustOk(ctx.addProduct(token, { name: 'Bolt', purchasePrice: 50, sellingPrice: 100, stock: 10, minStock: 1 }));

  const sale = mustOk(ctx.completeSale(token, {
    customerName: 'Due Buyer', customerPhone: '01799999999', paymentType: 'Due', discount: 0,
    date: '2026-11-10', items: [{ productId: prod.id, name: 'Bolt', qty: 5, unitPrice: 100, priceMode: 'manual' }]
  }));
  advanceSeconds(5);

  const ret = mustOk(ctx.completeReturn(token, {
    invoiceId: sale.invoiceId, refundMethod: 'Cash', reason: 'Cash paid out on due invoice', date: '2026-11-10',
    items: [{ productId: prod.id, name: 'Bolt', qty: 2 }]
  }));
  assert.equal(ret.totalReturnAmount, 200);
  const cust = ctx.getAllRows_('CUSTOMERS').find(c => c['Customer ID'] === sale.customerId);
  assert.equal(Number(cust['Current Due']), 500, 'Customer due stays unchanged on Cash refund');
  assert.equal(ctx.getCashBalance_(), 9800, 'Cash drawer decreases by 200 BDT');
});
