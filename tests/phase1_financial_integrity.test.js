'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createGasEnvironment, mustOk } = require('./helpers/gasHarness');

test('BUG-03 & Decision #1: Opening balances NEVER post Historical Opening rows to CASH_BOOK (before or after Start Day)', () => {
  // Case A: Opening balances added AFTER Start Day
  const envA = createGasEnvironment({ nowIso: '2026-11-10T09:00:00+06:00' });
  mustOk(envA.ctx.startCashSession(envA.token, 50000, 'Day 1 drawer'));
  mustOk(envA.ctx.addCustomerChecked(envA.token, { name: 'Rahim', phone: '01711111111', openingBalance: 20000 }));
  mustOk(envA.ctx.addSupplier(envA.token, { name: 'Karim', openingBalance: 30000 }));
  const owner = mustOk(envA.ctx.addFinancePerson(envA.token, { name: 'Owner Ali', roles: ['Owner', 'Lender'] }));
  mustOk(envA.ctx.addFinanceTransaction(envA.token, {
    date: '2026-11-10', transactionType: 'Opening Owner Capital', personId: owner.id, amount: 500000
  }));
  mustOk(envA.ctx.addFinanceTransaction(envA.token, {
    date: '2026-11-10', transactionType: 'Opening Loan', personId: owner.id, amount: 100000
  }));

  assert.equal(envA.ctx.getCashBalance_(), 50000, 'Physical cash balance must remain 50,000');
  const bsA = mustOk(envA.ctx.getBalanceSheetReport(envA.token));
  assert.equal(bsA.assets.cash, 50000);
  assert.equal(bsA.equity.ownerCapital, 500000);
  assert.equal(bsA.liabilities.outstandingLoan, 100000);
  const histRows = envA.ctx.activeRows_('CASH_BOOK').filter(r => r['Type'] === 'Historical Opening');
  assert.equal(histRows.length, 0);

  // Case B: Opening balances added BEFORE Start Day must NOT suppress Day 1 cash session baseline
  const envB = createGasEnvironment({ nowIso: '2026-11-10T09:00:00+06:00' });
  mustOk(envB.ctx.addCustomerChecked(envB.token, { name: 'Rahim', phone: '01711111111', openingBalance: 20000 }));
  mustOk(envB.ctx.startCashSession(envB.token, 50000, 'Day 1 drawer'));
  assert.equal(envB.ctx.getCashBalance_(), 50000, 'Day 1 opening cash baseline must still establish 50,000');

  // Case C: BUG-26 — Paying off supplier opening balance and deleting supplier must not corrupt Cash Book
  const envC = createGasEnvironment({ nowIso: '2026-11-10T09:00:00+06:00' });
  mustOk(envC.ctx.startCashSession(envC.token, 50000, 'Open'));
  const supC = mustOk(envC.ctx.addSupplier(envC.token, { name: 'Old Sup', openingBalance: 10000 }));
  mustOk(envC.ctx.paySupplier(envC.token, supC.id, 10000, 'Cash', '', 'Pay opening', '2026-11-10'));
  assert.equal(envC.ctx.getCashBalance_(), 40000);
  mustOk(envC.ctx.deleteSupplier(envC.token, supC.id, 'Settled and no longer used'));
  assert.equal(envC.ctx.getCashBalance_(), 40000, 'Deleting settled supplier must not alter Cash Balance');
});

test('Decision #1 Repair Tool: previewHistoricalOpeningCashRepair / applyHistoricalOpeningCashRepair safely soft-delete legacy Historical Opening rows', () => {
  const { ctx, token } = createGasEnvironment({ nowIso: '2026-11-10T09:00:00+06:00' });
  mustOk(ctx.startCashSession(token, 50000, 'Open'));
  // Seed legacy Historical Opening Cash Book rows from prior buggy version
  ctx.addCashBookEntry_({
    Type: 'Historical Opening', Reference: 'OPEN:Customer:CUS-000001',
    Description: 'Customer opening balance — Rahim', Debit: 20000, Credit: '', Date: '2026-11-10'
  });
  ctx.addCashBookEntry_({
    Type: 'Historical Opening', Reference: 'OPEN:Owner:FPER-000001',
    Description: 'Owner opening balance — Ali', Debit: '', Credit: 500000, Date: '2026-11-10'
  });
  assert.equal(ctx.getCashBalance_(), 530000);

  // Preview must be strictly read-only
  const preview = mustOk(ctx.previewHistoricalOpeningCashRepair(token));
  assert.equal(preview.rowCount, 2);
  assert.equal(preview.cashBalanceBefore, 530000);
  assert.equal(preview.cashBalanceAfter, 50000);
  assert.equal(preview.netCashAdjustment, -480000);
  assert.equal(ctx.getCashBalance_(), 530000, 'Preview must NOT mutate Cash Book');

  // Apply requires a reason and soft-deletes only Historical Opening rows
  const missingReason = ctx.applyHistoricalOpeningCashRepair(token, '');
  assert.equal(missingReason.success, false);

  const applied = mustOk(ctx.applyHistoricalOpeningCashRepair(token, 'Approved audit repair for BUG-03'));
  assert.equal(applied.repairedCount, 2);
  assert.equal(applied.cashBalanceAfter, 50000);
  assert.equal(ctx.getCashBalance_(), 50000);
  // Rows are soft-deleted, not hard-deleted
  const allCb = ctx.getAllRows_('CASH_BOOK').filter(r => r['Type'] === 'Historical Opening');
  assert.equal(allCb.length, 2);
  assert.equal(allCb.every(r => ctx.isDeleted_(r)), true);
});

test('BUG-04 & Decision #2: STOCK_LOTS keeps full gross Purchase Price; Profit Report books Net Purchase Discount Income (consistent with PurchaseReturn)', () => {
  const { ctx, token, advanceSeconds } = createGasEnvironment({ nowIso: '2026-11-10T09:00:00+06:00' });
  mustOk(ctx.startCashSession(token, 100000, 'Open'));
  const sup = mustOk(ctx.addSupplier(token, { name: 'Sup A', openingBalance: 0 }));
  const prod = mustOk(ctx.addProduct(token, { name: 'Bolt', purchasePrice: 100, sellingPrice: 110, stock: 0, minStock: 1 }));

  // Buy 10 @ 100 gross, Discount 100 => Paid 900 Cash
  const pur = mustOk(ctx.createPurchase(token, {
    supplierId: sup.id, date: '2026-11-10', discount: 100, paidAmount: 900, paymentMethod: 'Cash',
    items: [{ productId: prod.id, name: 'Bolt', qty: 10, unitPrice: 100, sellingPrice: 110 }]
  }));

  // Decision #2: Lot keeps gross Purchase Price = 100 -> Inventory Value = 1,000
  const lot = ctx.getAllRows_('STOCK_LOTS')[0];
  assert.equal(lot['Purchase Price'], 100);
  const profitBeforeReturn = mustOk(ctx.getProfitReport(token, { from: '2026-11-01', to: '2026-11-30' }));
  assert.equal(profitBeforeReturn.totals.purchaseDiscountIncome, 100);
  assert.equal(profitBeforeReturn.totals.netProfit, 100);

  // Return 4 units to supplier for Cash (PurchaseReturn refunds net 4 * 90 = 360)
  advanceSeconds(5);
  const ret = mustOk(ctx.completePurchaseReturn(token, {
    purchaseId: pur.purchaseId, refundMethod: 'Cash', reason: 'Excess', date: '2026-11-10',
    items: [{ productId: prod.id, name: 'Bolt', qty: 4 }]
  }));
  assert.equal(ret.totalReturnAmount, 360);

  // Sell remaining 6 units @ 110 Cash (Revenue = 660, Gross COGS = 6 * 100 = 600, Gross Profit = 60)
  advanceSeconds(5);
  mustOk(ctx.completeSale(token, {
    customerName: 'Cust 1', customerPhone: '01711111111', paymentType: 'Cash', paymentMethod: 'Cash', discount: 0,
    date: '2026-11-10',
    items: [{ productId: prod.id, name: 'Bolt', qty: 6, unitPrice: 110, priceMode: 'manual' }]
  }));

  const profitAfter = mustOk(ctx.getProfitReport(token, { from: '2026-11-01', to: '2026-11-30' }));
  assert.equal(profitAfter.totals.cogs, 600, 'COGS uses full gross lot price (6 * 100)');
  assert.equal(profitAfter.totals.grossProfit, 60, 'Gross profit = 660 - 600 = 60');
  assert.equal(profitAfter.totals.purchaseDiscountIncome, 60, 'Net purchase discount = 100 - 40 returned portion = 60');
  assert.equal(profitAfter.totals.netProfit, 120, 'Net profit (60 + 60 = 120) must equal actual Cash gain (-900 + 360 + 660 = 120)');
  assert.equal(ctx.getCashBalance_() - 100000, 120);
});

test('BUG-05 & BUG-22: Cross-request cache cannot poison mutable stock/lots; same-ms Profit Report cache invalidates cleanly', () => {
  const env = createGasEnvironment({ nowIso: '2026-11-10T09:00:00+06:00' });
  const { ctx, token } = env;
  mustOk(ctx.startCashSession(token, 10000, 'Open'));
  const prod = mustOk(ctx.addProduct(token, { name: 'Motor', purchasePrice: 1000, sellingPrice: 1500, stock: 10, minStock: 1 }));

  // Request A reads stock = 10 before Request B writes
  const reqA = env.newRequestContext();
  const staleLots = JSON.parse(JSON.stringify(reqA.getAllRows_('STOCK_LOTS')));
  const staleProducts = JSON.parse(JSON.stringify(reqA.getAllRows_('PRODUCTS')));

  // Request B sells 6 units (stock: 10 -> 4)
  const reqB = env.newRequestContext();
  mustOk(reqB.completeSale(token, {
    customerName: 'Buyer B', customerPhone: '01755555555', paymentType: 'Cash', paymentMethod: 'Cash', discount: 0,
    date: '2026-11-10', items: [{ productId: prod.id, name: 'Motor', qty: 6, unitPrice: 1500, priceMode: 'manual' }]
  }));

  // Simulate Request A finishing late and calling crossRequestRowsPut_ with stale snapshot
  reqA.crossRequestRowsPut_('STOCK_LOTS', staleLots);
  reqA.crossRequestRowsPut_('PRODUCTS', staleProducts);

  // Request C sells 3 units -> MUST NOT read stale stock=10 from CacheService!
  const reqC = env.newRequestContext();
  mustOk(reqC.completeSale(token, {
    customerName: 'Buyer C', customerPhone: '01766666666', paymentType: 'Cash', paymentMethod: 'Cash', discount: 0,
    date: '2026-11-10', items: [{ productId: prod.id, name: 'Motor', qty: 3, unitPrice: 1500, priceMode: 'manual' }]
  }));

  const verify = env.newRequestContext();
  assert.equal(verify.getAllRows_('PRODUCTS')[0]['Current Stock'], 1, 'Final stock must be 10 - 6 - 3 = 1');
  assert.equal(verify.getAllRows_('STOCK_LOTS')[0]['Remaining Quantity'], 1);

  // BUG-22: Two writes + Profit Report reads within the EXACT same millisecond (nowMs unchanged) must never return stale cached profit!
  const pBefore = mustOk(verify.getProfitReport(token, { from: '2026-11-01', to: '2026-11-30' }));
  assert.equal(pBefore.totals.grossProfit, 4500);
  mustOk(verify.completeSale(token, {
    customerName: 'Buyer D', customerPhone: '01777777777', paymentType: 'Cash', paymentMethod: 'Cash', discount: 0,
    date: '2026-11-10', items: [{ productId: prod.id, name: 'Motor', qty: 1, unitPrice: 1500, priceMode: 'manual' }]
  }));
  const pAfter = mustOk(verify.getProfitReport(token, { from: '2026-11-01', to: '2026-11-30' }));
  assert.equal(pAfter.totals.grossProfit, 5000, 'Same-millisecond Profit Report must reflect new sale immediately');
});

test('BUG-09 & BUG-24: roundMoney_ symmetric half-up BDT precision & completeSale 3-decimal discount never partial-commits/crashes', () => {
  const { ctx, token } = createGasEnvironment({ nowIso: '2026-11-10T09:00:00+06:00' });
  mustOk(ctx.startCashSession(token, 100000, 'Open'));

  // roundMoney_ precision cases
  assert.equal(ctx.roundMoney_(1.005), 1.01);
  assert.equal(ctx.roundMoney_(-1.005), -1.01);
  assert.equal(ctx.roundMoney_(35.855), 35.86);
  assert.equal(ctx.roundMoney_(267.835), 267.84);
  assert.equal(ctx.roundMoney_(1000000.005), 1000000.01);
  assert.equal(ctx.roundMoney_(0.1 + 0.2), 0.3);
  assert.equal(Object.is(ctx.roundMoney_(-0.001), -0), false);

  // completeSale with 3-decimal discount must succeed cleanly with rounded 2-decimal Paid Amount
  const prod = mustOk(ctx.addProduct(token, { name: 'Nail', purchasePrice: 10, sellingPrice: 100.1, stock: 20, minStock: 1 }));
  const sale = mustOk(ctx.completeSale(token, {
    customerName: 'Float Cust', customerPhone: '01711111111', paymentType: 'Cash', paymentMethod: 'Cash', discount: 0.005,
    date: '2026-11-10', items: [{ productId: prod.id, name: 'Nail', qty: 1, unitPrice: 100.1, priceMode: 'manual' }]
  }));
  assert.equal(sale.grandTotal, 100.09);
  assert.equal(sale.paidAmount, 100.09);

  // Supplier Current Due float drift check (0.1 + 0.2 === 0.3)
  const sup = mustOk(ctx.addSupplier(token, { name: 'Sup F', openingBalance: 0.1 }));
  mustOk(ctx.createPurchase(token, {
    supplierId: sup.id, date: '2026-11-10', discount: 0, paidAmount: 0,
    items: [{ productId: prod.id, name: 'Nail', qty: 0.2, unitPrice: 1, sellingPrice: 2 }]
  }));
  assert.equal(ctx.getAllRows_('SUPPLIERS')[0]['Current Due'], 0.3);
});

test('BUG-10: Inventory Valuation is consistent across Stock Report, Balance Sheet, and Products Bootstrap (excludes deleted lots/products)', () => {
  const { ctx, token, advanceSeconds } = createGasEnvironment({ nowIso: '2026-11-10T09:00:00+06:00' });
  mustOk(ctx.startCashSession(token, 100000, 'Open'));
  const sup = mustOk(ctx.addSupplier(token, { name: 'Sup A', openingBalance: 0 }));
  const prod = mustOk(ctx.addProduct(token, { name: 'Pipe', purchasePrice: 100, sellingPrice: 150, stock: 0, minStock: 1 }));

  mustOk(ctx.createPurchase(token, {
    supplierId: sup.id, date: '2026-11-10', discount: 0, paidAmount: 1000, paymentMethod: 'Cash',
    items: [{ productId: prod.id, name: 'Pipe', qty: 10, unitPrice: 100, sellingPrice: 150 }]
  }));
  // Inject a rogue deleted lot with non-zero Remaining Quantity to verify all 3 readers ignore Status='Deleted'
  ctx.appendRow_('STOCK_LOTS', {
    'Lot ID': 'LOT-999999', 'Product ID': prod.id, 'Product Name': 'Pipe',
    'Purchase ID': 'PUR-999999', 'Purchase Date': '2026-11-01',
    'Purchase Price': 500, 'Sell Price': 600,
    'Original Quantity': 5, 'Remaining Quantity': 5, 'Status': 'Deleted', 'Created At': new Date()
  });

  const stockRep = mustOk(ctx.getStockReport(token));
  const bs = mustOk(ctx.getBalanceSheetReport(token));
  const prods = mustOk(ctx.getProductsBootstrap(token));
  const prodRow = prods.products.find(p => p['Product ID'] === prod.id);

  assert.equal(stockRep.totals.inventoryValue, 1000);
  assert.equal(bs.assets.inventory, 1000);
  assert.equal(prodRow['Stock Value'], 1000);
  assert.equal(stockRep.products[0].lotMismatch, false);

  // Also test negative stock consistency: sell 12 units -> stock = -2, lot = -2 -> NOT a lotMismatch!
  advanceSeconds(5);
  mustOk(ctx.completeSale(token, {
    customerName: 'C1', customerPhone: '01711111111', paymentType: 'Cash', paymentMethod: 'Cash', discount: 0,
    date: '2026-11-10', items: [{ productId: prod.id, name: 'Pipe', qty: 12, unitPrice: 150, priceMode: 'manual' }]
  }));
  const stockRepNeg = mustOk(ctx.getStockReport(token));
  assert.equal(stockRepNeg.products[0].stock, -2);
  assert.equal(stockRepNeg.products[0].lotQuantity, -2);
  assert.equal(stockRepNeg.products[0].lotMismatch, false, 'Oversold product whose lot total equals Current Stock (-2) must not be flagged as lotMismatch');
});
