'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createGasEnvironment, mustOk } = require('./helpers/gasHarness');

test('BUG-07 & Decision #3: Damaged Sales Returns skip stock/lot restoration, keep COGS loss on Profit Report, and cap further returns', () => {
  const { ctx, token, advanceSeconds } = createGasEnvironment({ nowIso: '2026-11-10T09:00:00+06:00' });
  mustOk(ctx.startCashSession(token, 50000, 'Open'));
  const sup = mustOk(ctx.addSupplier(token, { name: 'Sup A', openingBalance: 0 }));
  const prod = mustOk(ctx.addProduct(token, { name: 'Glass Lamp', purchasePrice: 100, sellingPrice: 150, stock: 0, minStock: 1 }));
  mustOk(ctx.createPurchase(token, {
    supplierId: sup.id, date: '2026-11-10', discount: 0, paidAmount: 1000, paymentMethod: 'Cash',
    items: [{ productId: prod.id, name: 'Glass Lamp', qty: 10, unitPrice: 100, sellingPrice: 150 }]
  }));
  advanceSeconds(5);

  // Sell 5 @ 150 Cash -> Revenue 750, COGS 500, Gross Profit 250, Stock 5
  const sale = mustOk(ctx.completeSale(token, {
    customerName: 'Cust A', customerPhone: '01711111111', paymentType: 'Cash', paymentMethod: 'Cash', discount: 0,
    date: '2026-11-10', items: [{ productId: prod.id, name: 'Glass Lamp', qty: 5, unitPrice: 150, priceMode: 'manual' }]
  }));
  advanceSeconds(5);

  // Return 2 as Damaged (Cash refund 300)
  const dmgRet = mustOk(ctx.completeReturn(token, {
    invoiceId: sale.invoiceId, refundMethod: 'Cash', reason: 'Broken in transit', date: '2026-11-10',
    items: [{ productId: prod.id, name: 'Glass Lamp', qty: 2, condition: 'Damaged' }]
  }));
  assert.equal(dmgRet.totalReturnAmount, 300);

  // Damaged units must NOT enter sellable STOCK_LOTS or PRODUCTS.Current Stock
  assert.equal(ctx.getAllRows_('PRODUCTS')[0]['Current Stock'], 5, 'Damaged return must not increase Current Stock');
  assert.equal(ctx.getAllRows_('STOCK_LOTS')[0]['Remaining Quantity'], 5, 'Damaged return must not restore STOCK_LOTS');

  // Condition column stored on SALES_RETURN_ITEMS
  const retItem = ctx.getAllRows_('SALES_RETURN_ITEMS').find(r => r['Return ID'] === dmgRet.returnId);
  assert.equal(retItem['Condition'], 'Damaged');

  // Profit Report: Net Revenue = 750 - 300 = 450; COGS stays 5 * 100 = 500; Gross/Net Profit = -50 (reflects 200 loss on damaged goods vs 150 profit on 3 kept!)
  const prof = mustOk(ctx.getProfitReport(token, { from: '2026-11-01', to: '2026-11-30' }));
  assert.equal(prof.totals.netRevenue, 450);
  assert.equal(prof.totals.cogs, 500);
  assert.equal(prof.totals.grossProfit, -50);
  assert.equal(prof.totals.netProfit, -50);

  // Available qty for further returns on INV-1 must be 5 - 2 = 3
  const invView = mustOk(ctx.getInvoiceForReturn(token, sale.invoiceId));
  assert.equal(invView.items[0].availableQty, 3);
  const overRet = ctx.completeReturn(token, {
    invoiceId: sale.invoiceId, refundMethod: 'Cash', reason: 'Too many', date: '2026-11-10',
    items: [{ productId: prod.id, name: 'Glass Lamp', qty: 4, condition: 'Sellable' }]
  });
  assert.equal(overRet.success, false, 'Cannot return more than 3 remaining units');

  // Return 1 more as Sellable (default condition) -> Stock becomes 6, COGS drops by 100 to 400
  advanceSeconds(5);
  const sellRet = mustOk(ctx.completeReturn(token, {
    invoiceId: sale.invoiceId, refundMethod: 'Cash', reason: 'Unopened', date: '2026-11-10',
    items: [{ productId: prod.id, name: 'Glass Lamp', qty: 1 }]
  }));
  const sellRetItem = ctx.getAllRows_('SALES_RETURN_ITEMS').find(r => r['Return ID'] === sellRet.returnId);
  assert.equal(sellRetItem['Condition'], 'Sellable');
  assert.equal(ctx.getAllRows_('PRODUCTS')[0]['Current Stock'], 6);
  assert.equal(ctx.getAllRows_('STOCK_LOTS')[0]['Remaining Quantity'], 6);

  // Deleting a Damaged-only return must succeed cleanly (no stock movement evidence required)
  advanceSeconds(5);
  mustOk(ctx.deleteSalesReturn(token, dmgRet.returnId, 'Mistake'));
  assert.equal(ctx.getAllRows_('PRODUCTS')[0]['Current Stock'], 6, 'Deleting damaged return leaves stock unchanged');
  const profAfterDel = mustOk(ctx.getProfitReport(token, { from: '2026-11-01', to: '2026-11-30' }));
  assert.equal(profAfterDel.totals.netRevenue, 600);
  assert.equal(profAfterDel.totals.cogs, 400);
  assert.equal(profAfterDel.totals.grossProfit, 200);
});

test('BUG-12: SupplierSettlement treats Purchase Update credit as adjustment, not false Paid Amount', () => {
  const { ctx, token, advanceSeconds } = createGasEnvironment({ nowIso: '2026-11-10T09:00:00+06:00' });
  mustOk(ctx.startCashSession(token, 50000, 'Open'));
  const sup = mustOk(ctx.addSupplier(token, { name: 'Sup B', openingBalance: 0 }));
  const prod = mustOk(ctx.addProduct(token, { name: 'Pipe', purchasePrice: 100, sellingPrice: 150, stock: 0, minStock: 1 }));

  const pur = mustOk(ctx.createPurchase(token, {
    supplierId: sup.id, date: '2026-11-10', discount: 0, paidAmount: 0,
    items: [{ productId: prod.id, name: 'Pipe', qty: 10, unitPrice: 100, sellingPrice: 150 }]
  }));
  advanceSeconds(5);

  // Edit unpaid purchase down from 10@100 (1000) to 6@100 (600) Due
  mustOk(ctx.updatePurchase(token, pur.purchaseId, {
    supplierId: sup.id, date: '2026-11-10', discount: 0, paidAmount: 0, reason: 'Short delivery',
    items: [{ productId: prod.id, name: 'Pipe', qty: 6, unitPrice: 100, sellingPrice: 150 }]
  }));

  const detail = mustOk(ctx.getPurchaseDetail(token, pur.purchaseId));
  assert.equal(detail.grandTotal, 600);
  assert.equal(detail.paidAmount, 0, 'Unpaid edited purchase must NOT show false paidAmount of 400');
  assert.equal(detail.dueAmount, 600);
  assert.equal(detail.paymentStatus, 'Due');
});

test('BUG-13: Deleting or editing a non-split Due invoice after a later customer payment is blocked', () => {
  const { ctx, token, advanceSeconds } = createGasEnvironment({ nowIso: '2026-11-10T09:00:00+06:00' });
  mustOk(ctx.startCashSession(token, 10000, 'Open'));
  const prod = mustOk(ctx.addProduct(token, { name: 'Pump', purchasePrice: 500, sellingPrice: 1000, stock: 5, minStock: 1 }));

  // Normal non-split Due sale (Payment Detail Version = '')
  const sale = mustOk(ctx.completeSale(token, {
    customerName: 'Rahim', customerPhone: '01711111111', paymentType: 'Due', discount: 0,
    date: '2026-11-10', items: [{ productId: prod.id, name: 'Pump', qty: 1, unitPrice: 1000, priceMode: 'manual' }]
  }));
  advanceSeconds(5);

  // Customer pays 1000 Cash
  mustOk(ctx.receivePayment(token, sale.customerId, 1000, 'Cash', '', 'Full payment', '2026-11-10'));
  advanceSeconds(5);

  // Both updateSale and deleteSalesInvoice MUST reject
  const updRes = ctx.updateSale(token, sale.invoiceId, {
    customerId: sale.customerId, customerName: 'Rahim', customerPhone: '01711111111',
    paymentType: 'Due', discount: 0, reason: 'Try edit',
    items: [{ productId: prod.id, name: 'Pump', qty: 1, unitPrice: 900 }]
  });
  assert.equal(updRes.success, false, 'Editing a settled non-split invoice must be blocked');

  const delRes = ctx.deleteSalesInvoice(token, sale.invoiceId, 'Try delete paid invoice');
  assert.equal(delRes.success, false, 'Deleting a settled non-split invoice must be blocked');
  assert.equal(ctx.getAllRows_('CUSTOMERS').find(c => c['Customer ID'] === sale.customerId)['Current Due'], 0);
});

test('BUG-14 & Decision #4: Deleting closed-session Sale, Purchase, Expense, Payments, and Finance posts today-dated counter-entry without altering closed session', () => {
  const { ctx, token, advanceSeconds } = createGasEnvironment({ nowIso: '2026-11-10T09:00:00+06:00' });
  // Day 1: Open with 20,000
  mustOk(ctx.startCashSession(token, 20000, 'Day 1'));
  const sup = mustOk(ctx.addSupplier(token, { name: 'Sup D', openingBalance: 5000 }));
  const cust = mustOk(ctx.addCustomerChecked(token, { name: 'Cust D', phone: '01722222222', openingBalance: 3000 }));
  const prod = mustOk(ctx.addProduct(token, { name: 'Motor', purchasePrice: 500, sellingPrice: 1000, stock: 10, minStock: 1 }));
  const cat = mustOk(ctx.addExpenseCategory(token, { name: 'Rent' }));
  const payee = mustOk(ctx.addExpensePayee(token, { name: 'Landlord' }));
  const owner = mustOk(ctx.addFinancePerson(token, { name: 'Owner X', roles: ['Owner'] }));

  advanceSeconds(5);
  // Day 1 transactions:
  // 1. Sale: +1,000 Cash
  const sale = mustOk(ctx.completeSale(token, {
    customerName: 'Walk-in', customerPhone: '01700000001', paymentType: 'Cash', paymentMethod: 'Cash', discount: 0,
    date: '2026-11-10', items: [{ productId: prod.id, name: 'Motor', qty: 1, unitPrice: 1000, priceMode: 'manual' }]
  }));
  // 2. Purchase: -500 Cash
  const pur = mustOk(ctx.createPurchase(token, {
    supplierId: sup.id, date: '2026-11-10', discount: 0, paidAmount: 500, paymentMethod: 'Cash',
    items: [{ productId: prod.id, name: 'Motor', qty: 1, unitPrice: 500, sellingPrice: 1000 }]
  }));
  // 3. Expense: -200 Cash
  const exp = mustOk(ctx.addExpense(token, {
    date: '2026-11-10', categoryId: cat.id, payeeId: payee.id, amount: 200, paymentMethod: 'Cash', description: 'Day1 rent'
  }));
  // 4. Customer Payment: +400 Cash
  mustOk(ctx.receivePayment(token, cust.id, 400, 'Cash', '', 'Pay1', '2026-11-10'));
  const custPayId = ctx.getAllRows_('CUSTOMER_LEDGER').find(r => r['Type'] === 'Payment')['Ledger ID'];
  // 5. Supplier Payment: -600 Cash
  mustOk(ctx.paySupplier(token, sup.id, 600, 'Cash', '', 'SupPay1', '2026-11-10'));
  const supPayId = ctx.getAllRows_('SUPPLIER_LEDGER').find(r => r['Type'] === 'Payment')['Ledger ID'];
  // 6. Finance (Owner Investment): +1,500 Cash
  const fin = mustOk(ctx.addFinanceTransaction(token, {
    date: '2026-11-10', transactionType: 'Owner Investment', personId: owner.id, paymentMethod: 'Cash', amount: 1500
  }));

  // Day 1 closing cash = 20000 + 1000 - 500 - 200 + 400 - 600 + 1500 = 21,600
  assert.equal(ctx.getCashBalance_(), 21600);
  const day1Close = mustOk(ctx.closeCashSession(token, 21600, 'Day 1 close'));
  assert.equal(day1Close.expected, 21600);
  assert.equal(day1Close.variance, 0);

  // Snapshot Day 1 CASH_BOOK entries before Day 2 deletes
  const day1EntryIds = ctx.activeRows_('CASH_BOOK').map(r => r['Entry ID']);

  // Day 2: Open with 21,600
  advanceSeconds(86400);
  mustOk(ctx.startCashSession(token, 21600, 'Day 2'));
  advanceSeconds(5);

  // Delete ALL 6 closed-session transactions on Day 2!
  mustOk(ctx.deleteSalesInvoice(token, sale.invoiceId, 'Closed session sale delete'));
  mustOk(ctx.deletePurchase(token, pur.purchaseId, 'Closed session purchase delete'));
  mustOk(ctx.deleteExpense(token, exp.id, 'Closed session expense delete'));
  mustOk(ctx.deleteCustomerPayment(token, custPayId, 'Closed session cust pay delete'));
  mustOk(ctx.deleteSupplierPayment(token, supPayId, 'Closed session sup pay delete'));
  mustOk(ctx.deleteFinanceTransaction(token, fin.id, 'Closed session finance delete'));

  // 1. ALL original Day 1 CASH_BOOK rows MUST remain active (NOT soft-deleted!)
  const cbAll = ctx.getAllRows_('CASH_BOOK');
  day1EntryIds.forEach(entryId => {
    const row = cbAll.find(r => r['Entry ID'] === entryId);
    assert.equal(ctx.isDeleted_(row), false, 'Closed session Cash Book row ' + entryId + ' must NOT be soft-deleted');
  });

  // 2. Day 1 Cash & Bank Report closing balance MUST stay unchanged at 21,600!
  const day1Report = mustOk(ctx.getCashBankReport(token, { from: '2026-11-10', to: '2026-11-10' }));
  assert.equal(day1Report.cash.closing, 21600, 'Closed Day 1 cash closing must stay unchanged at 21,600');

  // 3. Today (Day 2) has 6 reversal counter-entries dated 2026-11-11, bringing live Cash Balance back to 20,000!
  assert.equal(ctx.getCashBalance_(), 20000);
  const day2Summary = mustOk(ctx.getCashSessionSummary(token));
  assert.equal(day2Summary.expectedCash, 20000, 'Day 2 open session expectedCash reflects today counter-entries');

  const reversals = ctx.activeRows_('CASH_BOOK').filter(r => String(r['Type'] || '').includes('Reversal'));
  assert.equal(reversals.length, 6, '6 reversal counter-entries posted for 6 closed-session deletes');
  reversals.forEach(r => {
    assert.equal(ctx.safeDateOnly_(r['Date']), '2026-11-11', 'Reversal counter-entry must be dated today (Day 2)');
  });

  // 4. Same-session delete (Day 2 expense deleted during Day 2) still soft-deletes cleanly (no extra reversal row)
  const day2Exp = mustOk(ctx.addExpense(token, {
    date: '2026-11-11', categoryId: cat.id, payeeId: payee.id, amount: 100, paymentMethod: 'Cash', description: 'Typo'
  }));
  mustOk(ctx.deleteExpense(token, day2Exp.id, 'Same session typo'));
  const day2ExpCb = ctx.getAllRows_('CASH_BOOK').find(r => r['Reference'] === day2Exp.id);
  assert.equal(ctx.isDeleted_(day2ExpCb), true, 'Same open-session delete still soft-deletes CASH_BOOK row');
  assert.equal(ctx.getCashBalance_(), 20000);
});

test('BUG-23: updateSale preserves Customer ID when edited from Due to Cash; receivePayment/paySupplier reject unknown methods', () => {
  const { ctx, token, advanceSeconds } = createGasEnvironment({ nowIso: '2026-11-10T09:00:00+06:00' });
  mustOk(ctx.startCashSession(token, 10000, 'Open'));
  const prod = mustOk(ctx.addProduct(token, { name: 'Tap', purchasePrice: 50, sellingPrice: 100, stock: 10, minStock: 1 }));
  const sup = mustOk(ctx.addSupplier(token, { name: 'Sup P', openingBalance: 500 }));

  const sale = mustOk(ctx.completeSale(token, {
    customerName: 'Karim', customerPhone: '01733333333', paymentType: 'Due', discount: 0,
    date: '2026-11-10', items: [{ productId: prod.id, name: 'Tap', qty: 2, unitPrice: 100, priceMode: 'manual' }]
  }));
  const origCustId = sale.customerId;
  assert.ok(origCustId);
  advanceSeconds(5);

  // Edit Due -> Cash
  mustOk(ctx.updateSale(token, sale.invoiceId, {
    customerId: origCustId, customerName: 'Karim', customerPhone: '01733333333',
    paymentType: 'Cash', paymentMethod: 'Cash', discount: 0, reason: 'Paid immediately',
    items: [{ productId: prod.id, name: 'Tap', qty: 2, unitPrice: 100 }]
  }));
  const saleRow = ctx.getAllRows_('SALES').find(s => s['Invoice ID'] === sale.invoiceId);
  assert.equal(saleRow['Customer ID'], origCustId, 'Customer ID must be preserved when edited to Cash');

  // Invalid payment method rejected
  const badCustPay = ctx.receivePayment(token, origCustId, 100, 'CryptoTypo', '', 'Bad', '2026-11-10');
  assert.equal(badCustPay.success, false, 'Unknown payment method must be rejected on receivePayment');
  const badSupPay = ctx.paySupplier(token, sup.id, 100, 'CryptoTypo', '', 'Bad', '2026-11-10');
  assert.equal(badSupPay.success, false, 'Unknown payment method must be rejected on paySupplier');
});

test('BUG-20 & BUG-29: PurchaseReturn date guard, cumulative rounding cap, lot-capped availableQty, active history, and deletePurchaseReturn', () => {
  const { ctx, token, advanceSeconds } = createGasEnvironment({ nowIso: '2026-11-10T09:00:00+06:00' });
  mustOk(ctx.startCashSession(token, 10000, 'Open'));
  const sup = mustOk(ctx.addSupplier(token, { name: 'Sup R', openingBalance: 0 }));
  const prod = mustOk(ctx.addProduct(token, { name: 'Fitting', purchasePrice: 100, sellingPrice: 150, stock: 0, minStock: 1 }));

  // Buy 3 @ 100, Discount 100 => Grand Total 200 Due on 2026-11-10
  const pur = mustOk(ctx.createPurchase(token, {
    supplierId: sup.id, date: '2026-11-10', discount: 100, paidAmount: 0,
    items: [{ productId: prod.id, name: 'Fitting', qty: 3, unitPrice: 100, sellingPrice: 150 }]
  }));
  advanceSeconds(5);

  // 1. Pre-purchase date MUST be rejected
  const earlyRet = ctx.completePurchaseReturn(token, {
    purchaseId: pur.purchaseId, refundMethod: 'Supplier Credit', reason: 'Early',
    date: '2026-11-05', backdatedReason: 'Test',
    items: [{ productId: prod.id, name: 'Fitting', qty: 1 }]
  });
  assert.equal(earlyRet.success, false, 'Purchase return before purchase date must be rejected');

  // 2. Three 1-unit returns must cap total at 200.00 (not 66.67 * 3 = 200.01)
  const r1 = mustOk(ctx.completePurchaseReturn(token, {
    purchaseId: pur.purchaseId, refundMethod: 'Supplier Credit', reason: 'Ret 1', date: '2026-11-10',
    items: [{ productId: prod.id, name: 'Fitting', qty: 1 }]
  }));
  const r2 = mustOk(ctx.completePurchaseReturn(token, {
    purchaseId: pur.purchaseId, refundMethod: 'Supplier Credit', reason: 'Ret 2', date: '2026-11-10',
    items: [{ productId: prod.id, name: 'Fitting', qty: 1 }]
  }));
  const r3 = mustOk(ctx.completePurchaseReturn(token, {
    purchaseId: pur.purchaseId, refundMethod: 'Supplier Credit', reason: 'Ret 3', date: '2026-11-10',
    items: [{ productId: prod.id, name: 'Fitting', qty: 1 }]
  }));
  assert.equal(ctx.roundMoney_(r1.totalReturnAmount + r2.totalReturnAmount + r3.totalReturnAmount), 200);
  assert.equal(ctx.getAllRows_('SUPPLIERS').find(s => s['Supplier ID'] === sup.id)['Current Due'], 0);

  // 3. deletePurchaseReturn restores stock, lot, supplier due, and hides deleted return from history/detail
  advanceSeconds(5);
  mustOk(ctx.deletePurchaseReturn(token, r3.returnId, 'Cancelled return 3'));
  assert.equal(ctx.getAllRows_('PRODUCTS')[0]['Current Stock'], 1);
  assert.equal(ctx.getAllRows_('STOCK_LOTS')[0]['Remaining Quantity'], 1);
  assert.equal(ctx.getAllRows_('SUPPLIERS').find(s => s['Supplier ID'] === sup.id)['Current Due'], r3.totalReturnAmount);

  const hist = mustOk(ctx.getPurchaseReturnHistory(token));
  assert.equal(hist.some(h => h['Return ID'] === r3.returnId), false, 'Deleted purchase return must not appear in history');
  const det = ctx.getPurchaseReturnDetail(token, r3.returnId);
  assert.equal(det.success, false, 'Deleted purchase return must not appear in detail');

  // 4. BUG-29: If remaining 1 unit is sold, getPurchaseForReturn.availableQty must be 0 (lot-capped!)
  mustOk(ctx.completeSale(token, {
    customerName: 'Buyer', customerPhone: '01755555555', paymentType: 'Cash', paymentMethod: 'Cash', discount: 0,
    date: '2026-11-10', items: [{ productId: prod.id, name: 'Fitting', qty: 1, unitPrice: 150, priceMode: 'manual' }]
  }));
  const purView = mustOk(ctx.getPurchaseForReturn(token, pur.purchaseId));
  assert.equal(purView.items[0].availableQty, 0, 'availableQty must be capped by unsold lot remaining (0)');
});
