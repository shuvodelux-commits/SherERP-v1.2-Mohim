'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createGasEnvironment, mustOk } = require('./helpers/gasHarness');

test('Vendor Issue & Partial Returns Received preserve exact multi-lot FIFO cost and keep Balance Sheet balanced', () => {
  const { ctx, token, advanceSeconds } = createGasEnvironment({ nowIso: '2026-11-15T10:00:00+06:00' });
  mustOk(ctx.startCashSession(token, 50000, 'Open'));
  const sup = mustOk(ctx.addSupplier(token, { name: 'Sup V', openingBalance: 0 }));
  const vendor = mustOk(ctx.addVendor(token, { name: 'Neighbor Hardware', phone: '01799990001' }));
  const prod = mustOk(ctx.addProduct(token, { name: 'Copper Tee', purchasePrice: 100, sellingPrice: 180, stock: 0, minStock: 1 }));

  // Buy 3 @ 100 = 300 and 5 @ 140 = 700 -> Total Inventory = 1,000
  mustOk(ctx.createPurchase(token, {
    supplierId: sup.id, date: '2026-11-15', discount: 0, paidAmount: 300, paymentMethod: 'Cash',
    items: [{ productId: prod.id, name: 'Copper Tee', qty: 3, unitPrice: 100, sellingPrice: 180 }]
  }));
  advanceSeconds(5);
  mustOk(ctx.createPurchase(token, {
    supplierId: sup.id, date: '2026-11-15', discount: 0, paidAmount: 700, paymentMethod: 'Cash',
    items: [{ productId: prod.id, name: 'Copper Tee', qty: 5, unitPrice: 140, sellingPrice: 180 }]
  }));
  advanceSeconds(5);
  assert.equal(mustOk(ctx.getStockReport(token)).totals.inventoryValue, 1000);

  // Give 5 units to vendor at agreed Unit Value = 150 (Total Receivable = 750; actual FIFO cost = 3*100 + 2*140 = 580)
  const issueRes = mustOk(ctx.giveProductsToVendor(token, {
    vendorId: vendor.id, date: '2026-11-15', notes: 'Loan stock',
    items: [{ productId: prod.id, quantity: 5, unitValue: 150 }]
  }));
  const issueRow = ctx.getAllRows_('VENDOR_ISSUES').find(r => r['Issue ID'] === issueRes.issueIds[0]);
  assert.equal(Number(issueRow['Total Cost']), 580, 'VENDOR_ISSUES must store exact consumed FIFO Total Cost (580)');
  assert.ok(String(issueRow['Cost Lots'] || '').includes(':3:100') && String(issueRow['Cost Lots'] || '').includes(':2:140'),
    'VENDOR_ISSUES must persist consumed Cost Lots breakdown');
  assert.equal(mustOk(ctx.getStockReport(token)).totals.inventoryValue, 420);
  advanceSeconds(5);

  // Return #1: vendor brings back 2 units (at Unit Value = 150) -> must restore at FIFO 2*100 = 200 (NOT 2*150 = 300!)
  mustOk(ctx.receiveProductsFromVendor(token, {
    vendorId: vendor.id, issueId: issueRes.issueIds[0], date: '2026-11-15', quantity: 2, unitValue: 150
  }));
  assert.equal(mustOk(ctx.getStockReport(token)).totals.inventoryValue, 620, 'Inventory after 2-unit return must be 420 + 200 = 620 (not 720)');
  advanceSeconds(5);

  // Return #2: vendor brings back remaining 3 units -> must restore 1*100 + 2*140 = 380 (NOT 3*150 = 450!)
  mustOk(ctx.receiveProductsFromVendor(token, {
    vendorId: vendor.id, issueId: issueRes.issueIds[0], date: '2026-11-15', quantity: 3, unitValue: 150
  }));
  assert.equal(mustOk(ctx.getStockReport(token)).totals.inventoryValue, 1000, 'Full return must restore exact original 1,000 inventory value');

  const bs = mustOk(ctx.getBalanceSheetReport(token));
  assert.equal(bs.assets.inventory, 1000);
  assert.equal(bs.assets.vendorReceivable, 0);
  assert.equal(bs.reconciliation.difference, 0, 'Balance Sheet must stay 100% balanced after vendor give & full return');
  assert.equal(bs.reconciliation.balanced, true);
});

test('Vendor Issue Edit (reduce & increase) and Delete restore exact FIFO costs; legacy rows without Cost Lots fall back safely', () => {
  const { ctx, token, advanceSeconds } = createGasEnvironment({ nowIso: '2026-11-15T10:00:00+06:00' });
  mustOk(ctx.startCashSession(token, 50000, 'Open'));
  const sup = mustOk(ctx.addSupplier(token, { name: 'Sup V2', openingBalance: 0 }));
  const vendor = mustOk(ctx.addVendor(token, { name: 'Partner Pipe', phone: '01799990002' }));
  const prod = mustOk(ctx.addProduct(token, { name: 'Union Joint', purchasePrice: 100, sellingPrice: 200, stock: 0, minStock: 1 }));

  // Buy 3 @ 100 = 300 and 5 @ 140 = 700 -> Inventory = 1,000
  mustOk(ctx.createPurchase(token, {
    supplierId: sup.id, date: '2026-11-15', discount: 0, paidAmount: 300, paymentMethod: 'Cash',
    items: [{ productId: prod.id, name: 'Union Joint', qty: 3, unitPrice: 100, sellingPrice: 200 }]
  }));
  advanceSeconds(5);
  mustOk(ctx.createPurchase(token, {
    supplierId: sup.id, date: '2026-11-15', discount: 0, paidAmount: 700, paymentMethod: 'Cash',
    items: [{ productId: prod.id, name: 'Union Joint', qty: 5, unitPrice: 140, sellingPrice: 200 }]
  }));
  advanceSeconds(5);

  // Give 5 units at Unit Value = 180 (FIFO cost = 3*100 + 2*140 = 580; remaining inventory = 420)
  const issueRes = mustOk(ctx.giveProductsToVendor(token, {
    vendorId: vendor.id, date: '2026-11-15', notes: 'Initial',
    items: [{ productId: prod.id, quantity: 5, unitValue: 180 }]
  }));
  const issueId = issueRes.issueIds[0];
  advanceSeconds(5);

  // Reduce qty 5 -> 4: must pop 1 @ 140 (LIFO) -> Inventory = 420 + 140 = 560 (NOT 420 + 180 = 600!)
  mustOk(ctx.updateVendorIssue(token, issueId, { date: '2026-11-15', quantity: 4, unitValue: 180, notes: 'Reduced' }));
  assert.equal(mustOk(ctx.getStockReport(token)).totals.inventoryValue, 560);
  let issueRow = ctx.getAllRows_('VENDOR_ISSUES').find(r => r['Issue ID'] === issueId);
  assert.equal(Number(issueRow['Total Cost']), 440);
  advanceSeconds(5);

  // Increase qty 4 -> 6: consumes 2 @ 140 -> Total Cost = 720, Inventory = 280
  mustOk(ctx.updateVendorIssue(token, issueId, { date: '2026-11-15', quantity: 6, unitValue: 180, notes: 'Increased' }));
  assert.equal(mustOk(ctx.getStockReport(token)).totals.inventoryValue, 280);
  issueRow = ctx.getAllRows_('VENDOR_ISSUES').find(r => r['Issue ID'] === issueId);
  assert.equal(Number(issueRow['Total Cost']), 720);
  advanceSeconds(5);

  // Delete Vendor Issue: restores exact 720 FIFO cost -> Inventory back to 1,000!
  mustOk(ctx.deleteVendorIssue(token, issueId, 'Cancelled loan'));
  assert.equal(mustOk(ctx.getStockReport(token)).totals.inventoryValue, 1000);
  const bs = mustOk(ctx.getBalanceSheetReport(token));
  assert.equal(bs.reconciliation.difference, 0);
  assert.equal(bs.reconciliation.balanced, true);

  // Legacy fallback: issue row without Cost Lots falls back to unitValue cleanly
  const legacyRes = mustOk(ctx.giveProductsToVendor(token, {
    vendorId: vendor.id, date: '2026-11-15', notes: 'Legacy',
    items: [{ productId: prod.id, quantity: 1, unitValue: 125 }]
  }));
  const legacyRow = ctx.getAllRows_('VENDOR_ISSUES').find(r => r['Issue ID'] === legacyRes.issueIds[0]);
  ctx.updateRowFields_('VENDOR_ISSUES', legacyRow._rowIndex, { 'Cost Lots': '', 'Total Cost': '' });
  mustOk(ctx.receiveProductsFromVendor(token, {
    vendorId: vendor.id, issueId: legacyRes.issueIds[0], date: '2026-11-15', quantity: 1, unitValue: 125
  }));
  const fallbackLot = ctx.getAllRows_('STOCK_LOTS').filter(l => l['Purchase ID'] === 'VENDOR-RETURN-RECEIVED').pop();
  assert.equal(Number(fallbackLot['Purchase Price']), 125, 'Legacy issue without Cost Lots must fall back to unitValue');
});
