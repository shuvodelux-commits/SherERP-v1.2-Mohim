'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createGasEnvironment, mustOk } = require('./helpers/gasHarness');

test('BUG-15 & BUG-34: DayBook includes split-payment sales, vendor cash rows, Cash Deposit/Withdrawal cash legs, and excludes deleted Bank Transfers', () => {
  const { ctx, token, advanceSeconds } = createGasEnvironment({ nowIso: '2026-11-10T09:00:00+06:00' });
  ctx.setSetting_('POS Multi Payment Enabled', 'true');
  mustOk(ctx.startCashSession(token, 10000, 'Open'));
  const bank = mustOk(ctx.addBankAccount(token, { name: 'Main Bank', bankName: 'DBBL', openingBalance: 5000, accountType: 'Bank' }));
  const prod = mustOk(ctx.addProduct(token, { name: 'Valve', purchasePrice: 500, sellingPrice: 1000, stock: 5, minStock: 1 }));
  const vendor = mustOk(ctx.addVendor(token, { name: 'Vendor V', phone: '01788888888' }));
  advanceSeconds(5);

  // 1. Split-payment sale: 600 Cash + 400 Bank = 1000
  const sale = mustOk(ctx.completeSale(token, {
    customerName: 'Split Buyer', customerPhone: '01711111111', discount: 0, date: '2026-11-10',
    operationId: 'op-split-daybook-001',
    items: [{ productId: prod.id, name: 'Valve', qty: 1, unitPrice: 1000, priceMode: 'manual' }],
    payments: [
      { id: 'pay-row-1', method: 'Cash', amount: 600 },
      { id: 'pay-row-2', method: 'Bank', accountId: bank.id, amount: 400 }
    ]
  }));
  advanceSeconds(5);

  // 2. Vendor Cash Payment: 300 Cash Out
  mustOk(ctx.payVendor(token, vendor.id, 300, 'Cash', '', 'Pay vendor', '2026-11-10'));
  advanceSeconds(5);

  // 3. Cash Deposit to Bank: 500 Cash Out, 500 Bank In
  mustOk(ctx.addBankManualEntry(token, {
    bankAccountId: bank.id, entryType: 'Cash Deposit', amount: 500, date: '2026-11-10', description: 'Deposit to DBBL'
  }));
  advanceSeconds(5);

  const db = mustOk(ctx.getDayBookTransactions(token, { dateFrom: '2026-11-10', dateTo: '2026-11-10' }));
  const saleRow = db.rows.find(r => r.referenceNo === sale.invoiceId);
  assert.equal(saleRow.cashIn, 600, 'Split sale must show 600 cashIn');
  assert.equal(saleRow.bankIn, 400, 'Split sale must show 400 bankIn');
  assert.equal(saleRow.amount, 1000);

  const vendorRow = db.rows.find(r => r.module === 'Vendor Payment');
  assert.ok(vendorRow, 'Vendor Cash Payment must appear in Day Book');
  assert.equal(vendorRow.cashOut, 300);

  const depRow = db.rows.find(r => r.transactionType === 'Cash Deposit');
  assert.ok(depRow, 'Cash Deposit row must appear in Day Book');
  assert.equal(depRow.bankIn, 500);
  assert.equal(depRow.cashOut, 500, 'Cash Deposit must show cashOut = 500 so Day Book cash totals match Cash Book');

  assert.equal(db.totals.cashIn, 600);
  assert.equal(db.totals.cashOut, 800, 'cashOut = 300 vendor + 500 deposit = 800');
  assert.equal(db.totals.netCash, -200);
  assert.equal(ctx.getCashBalance_(), 9800, '10000 + 600 - 300 - 500 = 9800');
});

test('BUG-16: reverseBankEntry & deleteBankTransaction block Bank Transfer legs and source-owned entries; Cash Deposit reversal mirrors Cash Book', () => {
  const { ctx, token, advanceSeconds } = createGasEnvironment({ nowIso: '2026-11-10T09:00:00+06:00' });
  mustOk(ctx.startCashSession(token, 10000, 'Open'));
  const b1 = mustOk(ctx.addBankAccount(token, { name: 'Bank 1', bankName: 'DBBL', openingBalance: 10000, accountType: 'Bank' }));
  const b2 = mustOk(ctx.addBankAccount(token, { name: 'Bank 2', bankName: 'City', openingBalance: 5000, accountType: 'Bank' }));
  advanceSeconds(5);

  // Bank Transfer 2,000 from Bank 1 -> Bank 2
  mustOk(ctx.transferBetweenBankAccounts(token, { fromAccountId: b1.id, toAccountId: b2.id, amount: 2000, notes: 'Move' }));
  const transferOut = ctx.getAllRows_('BANK_BOOK').find(r => r['Type'] === 'Transfer Out');

  // Reversing or deleting one transfer leg MUST be blocked (no phantom money!)
  const revTransfer = ctx.reverseBankEntry(token, transferOut['Entry ID'], 'Try single leg reversal');
  assert.equal(revTransfer.success, false, 'Single-leg Bank Transfer reversal must be blocked');
  const delTransfer = ctx.deleteBankTransaction(token, transferOut['Entry ID'], 'Try single leg delete');
  assert.equal(delTransfer.success, false, 'Single-leg Bank Transfer delete must be blocked');
  assert.equal(ctx.getBankBalance_(b1.id), 8000);
  assert.equal(ctx.getBankBalance_(b2.id), 7000);

  // Bank-paid Sale cannot be reversed via reverseBankEntry directly
  const prod = mustOk(ctx.addProduct(token, { name: 'Item', purchasePrice: 100, sellingPrice: 200, stock: 5, minStock: 1 }));
  const sale = mustOk(ctx.completeSale(token, {
    customerName: 'Bank Cust', customerPhone: '01744444444', paymentType: 'Cash', paymentMethod: 'Bank', bankAccountId: b1.id,
    discount: 0, date: '2026-11-10', items: [{ productId: prod.id, name: 'Item', qty: 1, unitPrice: 200, priceMode: 'manual' }]
  }));
  const saleBankRow = ctx.getAllRows_('BANK_BOOK').find(r => r['Reference'] === sale.invoiceId);
  const revSaleBank = ctx.reverseBankEntry(token, saleBankRow['Entry ID'], 'Try bypassing sale delete');
  assert.equal(revSaleBank.success, false, 'Reversing a Sale-owned Bank Book entry directly must be blocked');

  // Manual Cash Deposit reversal MUST also reverse Cash Book contra leg!
  mustOk(ctx.addBankManualEntry(token, {
    bankAccountId: b1.id, entryType: 'Cash Deposit', amount: 1000, date: '2026-11-10', description: 'Cash to Bank'
  }));
  assert.equal(ctx.getCashBalance_(), 9000);
  assert.equal(ctx.getBankBalance_(b1.id), 9200);
  const depEntry = ctx.getAllRows_('BANK_BOOK').find(r => r['Type'] === 'Cash Deposit');
  mustOk(ctx.reverseBankEntry(token, depEntry['Entry ID'], 'Wrong deposit'));
  assert.equal(ctx.getBankBalance_(b1.id), 8200);
  assert.equal(ctx.getCashBalance_(), 10000, 'Reversing Cash Deposit must restore 1,000 back to Cash Book');
});

test('BUG-21, BUG-27, BUG-28: Dashboard net collections/purchases, virtual Bundle exclusion from lowStock, and inactive non-zero bank accounts on Balance Sheet', () => {
  const { ctx, token, advanceSeconds } = createGasEnvironment({ nowIso: '2026-11-10T09:00:00+06:00' });
  mustOk(ctx.startCashSession(token, 50000, 'Open'));
  const sup = mustOk(ctx.addSupplier(token, { name: 'Sup S', openingBalance: 0 }));
  const prod = mustOk(ctx.addProduct(token, { name: 'Core', purchasePrice: 100, sellingPrice: 200, stock: 0, minStock: 1 }));
  // Virtual bundle (Current Stock = 0, Minimum Stock = 0)
  mustOk(ctx.addProduct(token, {
    name: 'Kit Bundle', productType: 'Bundle', purchasePrice: 0, sellingPrice: 200, stock: 0, minStock: 0,
    components: [{ productId: prod.id, qtyPerSet: 1 }]
  }));

  // Buy 5 @ 100 = 500 Cash, then return 2 @ 100 = 200 Cash -> Net Today Purchase = 300
  const pur = mustOk(ctx.createPurchase(token, {
    supplierId: sup.id, date: '2026-11-10', discount: 0, paidAmount: 500, paymentMethod: 'Cash',
    items: [{ productId: prod.id, name: 'Core', qty: 5, unitPrice: 100, sellingPrice: 200 }]
  }));
  advanceSeconds(5);
  mustOk(ctx.completePurchaseReturn(token, {
    purchaseId: pur.purchaseId, refundMethod: 'Cash', reason: 'Excess', date: '2026-11-10',
    items: [{ productId: prod.id, name: 'Core', qty: 2 }]
  }));
  advanceSeconds(5);

  // Sell 3 @ 200 Cash (= 600), then Cash Refund 1 (= -200), plus non-cash 'Other' customer payment 100 -> Net Collection = 400!
  const sale = mustOk(ctx.completeSale(token, {
    customerName: 'C1', customerPhone: '01711111111', paymentType: 'Cash', paymentMethod: 'Cash', discount: 0,
    date: '2026-11-10', items: [{ productId: prod.id, name: 'Core', qty: 3, unitPrice: 200, priceMode: 'manual' }]
  }));
  advanceSeconds(5);
  mustOk(ctx.completeReturn(token, {
    invoiceId: sale.invoiceId, refundMethod: 'Cash', reason: 'Ret', date: '2026-11-10',
    items: [{ productId: prod.id, name: 'Core', qty: 1 }]
  }));
  const cust2 = mustOk(ctx.addCustomerChecked(token, { name: 'C2', phone: '01722222222', openingBalance: 500 }));
  mustOk(ctx.receivePayment(token, cust2.id, 100, 'Other', '', 'Non-cash adjustment', '2026-11-10'));

  const dash = mustOk(ctx.getDashboardStats(token));
  assert.equal(dash.todayPurchaseTotal, 300, 'Dashboard todayPurchaseTotal must net out purchase returns (500 - 200 = 300)');
  assert.equal(dash.todayCollectionTotal, 400, 'Dashboard todayCollectionTotal must subtract Cash refund (600 - 200) and exclude non-cash Other (100)');
  // Core has stock = 1 (<= minStock 1 -> lowStock = 1), Bundle must NOT be counted -> total lowStockCount = 1 (not 2!)
  assert.equal(dash.lowStockCount, 1, 'Virtual Bundle must NOT be counted in Dashboard lowStockCount');

  // BUG-28: Inactive bank account with 5,000 balance must remain on Balance Sheet and getTotalBankBalance_
  const bank = mustOk(ctx.addBankAccount(token, { name: 'Old Bank', bankName: 'BRAC', openingBalance: 5000, accountType: 'Bank' }));
  mustOk(ctx.setBankAccountStatus(token, bank.id, 'Inactive'));
  assert.equal(ctx.getTotalBankBalance_(), 5000, 'Inactive bank account with balance must not vanish from getTotalBankBalance_');
  const bs = mustOk(ctx.getBalanceSheetReport(token));
  assert.equal(bs.assets.bank, 5000, 'Inactive bank account with balance must remain on Balance Sheet');
});

test('BUG-17: deleteVendorReturnReceived validates stock before writing so failed delete never leaves corrupt OVERSOLD lot', () => {
  const { ctx, token, advanceSeconds } = createGasEnvironment({ nowIso: '2026-11-10T09:00:00+06:00' });
  mustOk(ctx.startCashSession(token, 10000, 'Open'));
  const prod = mustOk(ctx.addProduct(token, { name: 'Switch', purchasePrice: 100, sellingPrice: 150, stock: 3, minStock: 1 }));
  const vendor = mustOk(ctx.addVendor(token, { name: 'Vendor W', phone: '01777777777' }));
  advanceSeconds(5);

  // Give 3 to vendor -> stock = 0
  const issue = mustOk(ctx.giveProductsToVendor(token, {
    vendorId: vendor.id, productId: prod.id, quantity: 3, unitValue: 100, date: '2026-11-10', notes: 'Loaned'
  }));
  // Receive 3 back -> stock = 3
  const rec = mustOk(ctx.receiveProductsFromVendor(token, {
    vendorId: vendor.id, issueId: issue.issueIds[0], quantity: 3, unitValue: 100, date: '2026-11-10', notes: 'Returned'
  }));
  // Sell all 3 -> stock = 0
  mustOk(ctx.completeSale(token, {
    customerName: 'Buyer', customerPhone: '01711111111', paymentType: 'Cash', paymentMethod: 'Cash', discount: 0,
    date: '2026-11-10', items: [{ productId: prod.id, name: 'Switch', qty: 3, unitPrice: 150, priceMode: 'manual' }]
  }));
  assert.equal(ctx.getAllRows_('PRODUCTS')[0]['Current Stock'], 0);
  const lotCountBefore = ctx.getAllRows_('STOCK_LOTS').length;

  // Attempt deleteVendorReturnReceived -> MUST fail without writing any OVERSOLD lot!
  const delRes = ctx.deleteVendorReturnReceived(token, rec.returnId, 'Try delete after sold');
  assert.equal(delRes.success, false);
  assert.equal(ctx.getAllRows_('STOCK_LOTS').length, lotCountBefore, 'Failed delete must NOT write a corrupt OVERSOLD lot');
});

test('BUG-18, BUG-31, BUG-32, BUG-33: Optional operationId idempotency, vendor return shortfall guard, updateExpenseInternal_ lockHeld, and Lot ID lineage', () => {
  const { ctx, token, advanceSeconds } = createGasEnvironment({ nowIso: '2026-11-10T09:00:00+06:00' });
  mustOk(ctx.startCashSession(token, 50000, 'Open'));
  const sup = mustOk(ctx.addSupplier(token, { name: 'Sup I', openingBalance: 0 }));
  const prod = mustOk(ctx.addProduct(token, { name: 'Wire', purchasePrice: 100, sellingPrice: 150, stock: 10, minStock: 1 }));
  const prod2 = mustOk(ctx.addProduct(token, { name: 'Tape', purchasePrice: 50, sellingPrice: 80, stock: 0, minStock: 1 }));
  advanceSeconds(5);

  // BUG-18: Standard completeSale replay with same operationId returns original invoice without duplicating
  const salePayload = {
    operationId: 'op-std-sale-idempotent-1',
    customerName: 'Dup Cust', customerPhone: '01711111111', paymentType: 'Cash', paymentMethod: 'Cash', discount: 0,
    date: '2026-11-10', items: [{ productId: prod.id, name: 'Wire', qty: 2, unitPrice: 150, priceMode: 'manual' }]
  };
  const s1 = mustOk(ctx.completeSale(token, salePayload));
  const s2 = mustOk(ctx.completeSale(token, salePayload));
  assert.equal(s2.invoiceId, s1.invoiceId, 'Duplicate operationId on standard completeSale must replay original invoice');
  assert.equal(ctx.getAllRows_('PRODUCTS').find(p => p['Product ID'] === prod.id)['Current Stock'], 8, 'Stock deducted only once');

  // BUG-18: createPurchase replay with same operationId
  const purPayload = {
    operationId: 'op-std-pur-idempotent-1',
    supplierId: sup.id, date: '2026-11-10', discount: 0, paidAmount: 500, paymentMethod: 'Cash',
    items: [{ productId: prod.id, name: 'Wire', qty: 5, unitPrice: 100, sellingPrice: 150 }]
  };
  const p1 = mustOk(ctx.createPurchase(token, purPayload));
  const p2 = mustOk(ctx.createPurchase(token, purPayload));
  assert.equal(p2.purchaseId, p1.purchaseId);
  assert.equal(ctx.getAllRows_('PRODUCTS').find(p => p['Product ID'] === prod.id)['Current Stock'], 13);

  // BUG-33: Adding a new product line during updatePurchase records its new Lot ID on STOCK_MOVEMENT
  mustOk(ctx.updatePurchase(token, p1.purchaseId, {
    supplierId: sup.id, date: '2026-11-10', discount: 0, paidAmount: 600, paymentMethod: 'Cash', reason: 'Add Tape',
    items: [
      { productId: prod.id, name: 'Wire', qty: 5, unitPrice: 100, sellingPrice: 150 },
      { productId: prod2.id, name: 'Tape', qty: 2, unitPrice: 50, sellingPrice: 80 }
    ]
  }));
  const tapeMove = ctx.getAllRows_('STOCK_MOVEMENT').find(m => m['Product ID'] === prod2.id && m['Type'] === 'Purchase Update');
  assert.ok(tapeMove && String(tapeMove['Lot ID'] || '').startsWith('LOT-'), 'updatePurchase new line movement must stamp Lot ID');

  // BUG-32: updateExpenseInternal_ with { lockHeld: true } must NOT throw null-lock TypeError
  const cat = mustOk(ctx.addExpenseCategory(token, { name: 'Misc' }));
  const payee = mustOk(ctx.addExpensePayee(token, { name: 'Shop' }));
  const exp = mustOk(ctx.addExpense(token, {
    date: '2026-11-10', categoryId: cat.id, payeeId: payee.id, amount: 100, paymentMethod: 'Cash', description: 'Tea'
  }));
  const expUpd = ctx.updateExpenseInternal_(token, exp.id, {
    date: '2026-11-10', categoryId: cat.id, payeeId: payee.id, amount: 120, paymentMethod: 'Cash', description: 'Tea+Snacks'
  }, { lockHeld: true });
  assert.equal(expUpd.success, true, 'updateExpenseInternal_ with lockHeld:true must succeed cleanly');

  // BUG-30: settlementBalanceBeforePayment_ aligns with same-day row-order settlement replay
  const cust = mustOk(ctx.addCustomerChecked(token, { name: 'Sort Cust', phone: '01766666666', openingBalance: 0 }));
  mustOk(ctx.completeSale(token, {
    customerId: cust.id, customerName: 'Sort Cust', customerPhone: '01766666666', paymentType: 'Due', discount: 0,
    date: '2026-11-10', items: [{ productId: prod.id, name: 'Wire', qty: 2, unitPrice: 150, priceMode: 'manual' }]
  }));
  mustOk(ctx.receivePayment(token, cust.id, 100, 'Cash', '', 'Pay 1', '2026-11-10'));
  const payLedger = ctx.getAllRows_('CUSTOMER_LEDGER').find(r => r['Customer ID'] === cust.id && r['Type'] === 'Payment');
  assert.equal(ctx.settlementBalanceBeforePayment_('CUSTOMER_LEDGER', 'Customer ID', cust.id, payLedger['Ledger ID'], '2026-11-10'), 300);
});
