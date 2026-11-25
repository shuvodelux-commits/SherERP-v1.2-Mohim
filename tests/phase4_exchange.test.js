'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createGasEnvironment, mustOk } = require('./helpers/gasHarness');

test('Guided Exchange: Even exchange, Upgrade (customer pays diff), and Downgrade (Cash & Store Credit) preserve exact FIFO COGS and 0.00 Balance Sheet', () => {
  const { ctx, token, advanceSeconds } = createGasEnvironment({ nowIso: '2026-11-15T10:00:00+06:00' });
  mustOk(ctx.startCashSession(token, 10000, 'Open'));

  const cust = mustOk(ctx.addCustomerChecked(token, { name: 'Karim', phone: '01766660001', openingBalance: 0 }));
  const prodA = mustOk(ctx.addProduct(token, { name: 'Faucet A', purchasePrice: 100, sellingPrice: 200, stock: 5, minStock: 1 }));
  const prodB = mustOk(ctx.addProduct(token, { name: 'Faucet B', purchasePrice: 120, sellingPrice: 200, stock: 5, minStock: 1 }));
  const prodC = mustOk(ctx.addProduct(token, { name: 'Faucet C Pro', purchasePrice: 210, sellingPrice: 350, stock: 5, minStock: 1 }));
  const prodD = mustOk(ctx.addProduct(token, { name: 'Faucet D Mini', purchasePrice: 70, sellingPrice: 120, stock: 5, minStock: 1 }));

  // Sell 4 Faucet A @ 200 = 800 Cash to Karim
  const sale = mustOk(ctx.completeSale(token, {
    customerId: cust.id, customerName: 'Karim', customerPhone: '01766660001',
    paymentType: 'Cash', paymentMethod: 'Cash', discount: 0, date: '2026-11-15',
    items: [{ productId: prodA.id, name: 'Faucet A', qty: 4, unitPrice: 200, priceMode: 'manual' }]
  }));
  advanceSeconds(5);

  const cashAfterInitialSale = ctx.getCashBalance_();
  assert.equal(cashAfterInitialSale, 10800);

  // 1. Even Exchange: Return 1 Faucet A (200) -> Replace with 1 Faucet B (200)
  const exEven = mustOk(ctx.completeExchange(token, {
    invoiceId: sale.invoiceId,
    date: '2026-11-15',
    reason: 'Color swap',
    returnItems: [{ productId: prodA.id, name: 'Faucet A', qty: 1, condition: 'Sellable' }],
    replacementItems: [{ productId: prodB.id, name: 'Faucet B', qty: 1, unitPrice: 200, priceMode: 'manual' }]
  }));
  assert.equal(exEven.returnTotal, 200);
  assert.equal(exEven.replacementTotal, 200);
  assert.equal(exEven.netDifference, 0);
  assert.equal(ctx.getCashBalance_(), 10800, 'Even exchange must not move Cash');
  assert.equal(ctx.getAllRows_('CUSTOMERS').find(c => c['Customer ID'] === cust.id)['Current Due'], 0);
  assert.equal(mustOk(ctx.getBalanceSheetReport(token)).reconciliation.difference, 0);
  advanceSeconds(5);

  // 2. Upgrade Exchange: Return 1 Faucet A (200) -> Replace with 1 Faucet C Pro (350), customer pays +150 Cash diff
  const exUp = mustOk(ctx.completeExchange(token, {
    invoiceId: sale.invoiceId,
    date: '2026-11-15',
    reason: 'Upgrade',
    returnItems: [{ productId: prodA.id, name: 'Faucet A', qty: 1, condition: 'Sellable' }],
    replacementItems: [{ productId: prodC.id, name: 'Faucet C Pro', qty: 1, unitPrice: 350, priceMode: 'manual' }],
    paidDifference: 150,
    paymentMethod: 'Cash'
  }));
  assert.equal(exUp.netDifference, 150);
  assert.equal(ctx.getCashBalance_(), 10950, 'Cash must rise by exact +150 difference');
  assert.equal(ctx.getAllRows_('CUSTOMERS').find(c => c['Customer ID'] === cust.id)['Current Due'], 0);
  assert.equal(mustOk(ctx.getBalanceSheetReport(token)).reconciliation.difference, 0);
  advanceSeconds(5);

  // 3a. Downgrade Exchange (Cash diff refund): Return 1 Faucet A (200) -> Replace with 1 Faucet D Mini (120) -> -80 Cash
  const exDownCash = mustOk(ctx.completeExchange(token, {
    invoiceId: sale.invoiceId,
    date: '2026-11-15',
    reason: 'Smaller model',
    returnItems: [{ productId: prodA.id, name: 'Faucet A', qty: 1, condition: 'Sellable' }],
    replacementItems: [{ productId: prodD.id, name: 'Faucet D Mini', qty: 1, unitPrice: 120, priceMode: 'manual' }],
    refundDiffMethod: 'Cash'
  }));
  assert.equal(exDownCash.netDifference, -80);
  assert.equal(ctx.getCashBalance_(), 10870, 'Cash must drop by exact -80 difference (10950 - 80 = 10870)');
  assert.equal(ctx.getAllRows_('CUSTOMERS').find(c => c['Customer ID'] === cust.id)['Current Due'], 0);
  assert.equal(mustOk(ctx.getBalanceSheetReport(token)).reconciliation.difference, 0);
  advanceSeconds(5);

  // 3b. Downgrade Exchange (Store Credit diff): Return last 1 Faucet A (200) -> Replace with 1 Faucet D Mini (120) -> -80 Customer Due
  const exDownCredit = mustOk(ctx.completeExchange(token, {
    invoiceId: sale.invoiceId,
    date: '2026-11-15',
    reason: 'Smaller model credit',
    returnItems: [{ productId: prodA.id, name: 'Faucet A', qty: 1, condition: 'Sellable' }],
    replacementItems: [{ productId: prodD.id, name: 'Faucet D Mini', qty: 1, unitPrice: 120, priceMode: 'manual' }],
    refundDiffMethod: 'Store Credit'
  }));
  assert.equal(exDownCredit.netDifference, -80);
  assert.equal(ctx.getCashBalance_(), 10870, 'Cash unchanged when refundDiffMethod is Store Credit');
  assert.equal(ctx.getAllRows_('CUSTOMERS').find(c => c['Customer ID'] === cust.id)['Current Due'], -80);

  // Final Profit check:
  // Original 4 A sold (800), all 4 A returned (-800). Replacement sales: 1 B (200-120=80) + 1 C (350-210=140) + 2 D (240-140=100) = 320 Net Profit!
  const prof = mustOk(ctx.getProfitReport(token, { from: '2026-11-15', to: '2026-11-15' }));
  assert.equal(prof.totals.netRevenue, 790, '200 + 350 + 120 + 120 = 790');
  assert.equal(prof.totals.cogs, 470, '120 + 210 + 70 + 70 = 470');
  assert.equal(prof.totals.netProfit, 320);

  const bs = mustOk(ctx.getBalanceSheetReport(token));
  assert.equal(bs.reconciliation.difference, 0);
  assert.equal(bs.reconciliation.balanced, true);
});

test('Guided Exchange: atomic validation rejects invalid replacement item before writing any return or sale', () => {
  const { ctx, token } = createGasEnvironment({ nowIso: '2026-11-15T10:00:00+06:00' });
  mustOk(ctx.startCashSession(token, 10000, 'Open'));
  const prodA = mustOk(ctx.addProduct(token, { name: 'Valve X', purchasePrice: 100, sellingPrice: 200, stock: 5, minStock: 1 }));
  const sale = mustOk(ctx.completeSale(token, {
    customerName: 'Walkin', customerPhone: '01700000099', paymentType: 'Cash', paymentMethod: 'Cash', discount: 0,
    date: '2026-11-15', items: [{ productId: prodA.id, name: 'Valve X', qty: 2, unitPrice: 200, priceMode: 'manual' }]
  }));

  const returnsBefore = ctx.getAllRows_('SALES_RETURN').length;
  const salesBefore = ctx.getAllRows_('SALES').length;
  const stockBefore = ctx.getAllRows_('PRODUCTS')[0]['Current Stock'];

  const bad = ctx.completeExchange(token, {
    invoiceId: sale.invoiceId,
    date: '2026-11-15',
    reason: 'Bad replacement',
    returnItems: [{ productId: prodA.id, name: 'Valve X', qty: 1, condition: 'Sellable' }],
    replacementItems: [{ productId: 'NON_EXISTENT', name: 'Ghost', qty: 1, unitPrice: 200, priceMode: 'manual' }]
  });
  assert.equal(bad.success, false);
  assert.equal(ctx.getAllRows_('SALES_RETURN').length, returnsBefore, 'Failed exchange must NOT write a partial return');
  assert.equal(ctx.getAllRows_('SALES').length, salesBefore, 'Failed exchange must NOT write a partial sale');
  assert.equal(ctx.getAllRows_('PRODUCTS')[0]['Current Stock'], stockBefore, 'Failed exchange must NOT touch stock');
});
