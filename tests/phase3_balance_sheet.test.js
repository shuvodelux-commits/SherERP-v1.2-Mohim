'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createGasEnvironment, mustOk } = require('./helpers/gasHarness');

test('Full Double-Entry Balance Sheet: Assets === Liabilities + Equity across complete multi-module ERP lifecycle', () => {
  const { ctx, token, advanceSeconds } = createGasEnvironment({ nowIso: '2026-11-10T09:00:00+06:00' });

  // 1. Opening Setup:
  //    Cash 50,000 + Bank 30,000 + Opening Stock (5 @ 100 = 500) + Customer Opening 4,000
  //    - Supplier Opening 6,000 - Opening Loan 10,000 - Opening Owner Capital 68,500 => Opening Equity = 0!
  mustOk(ctx.startCashSession(token, 50000, 'Day 1'));
  const bank = mustOk(ctx.addBankAccount(token, { name: 'DBBL Main', bankName: 'DBBL', openingBalance: 30000, accountType: 'Bank' }));
  const prod = mustOk(ctx.addProduct(token, { name: 'Valve', purchasePrice: 100, sellingPrice: 160, stock: 5, minStock: 1 }));
  const cust = mustOk(ctx.addCustomerChecked(token, { name: 'Rahim', phone: '01711111111', openingBalance: 4000 }));
  const sup = mustOk(ctx.addSupplier(token, { name: 'Karim Traders', openingBalance: 6000 }));
  const vendor = mustOk(ctx.addVendor(token, { name: 'Consign Vendor', phone: '01788888888' }));
  const owner = mustOk(ctx.addFinancePerson(token, { name: 'Owner', roles: ['Owner', 'Lender', 'Borrower'] }));
  const cat = mustOk(ctx.addExpenseCategory(token, { name: 'Utilities' }));
  const payee = mustOk(ctx.addExpensePayee(token, { name: 'DESCO' }));

  mustOk(ctx.addFinanceTransaction(token, {
    date: '2026-11-10', transactionType: 'Opening Owner Capital', personId: owner.id, amount: 68500
  }));
  mustOk(ctx.addFinanceTransaction(token, {
    date: '2026-11-10', transactionType: 'Opening Loan', personId: owner.id, amount: 10000
  }));

  let bs = mustOk(ctx.getBalanceSheetReport(token));
  assert.equal(bs.assets.total, 84500);
  assert.equal(bs.liabilities.total, 16000);
  assert.equal(bs.equity.ownerCapital, 68500);
  assert.equal(bs.equity.openingBalanceEquity, 0);
  assert.equal(bs.equity.retainedEarnings, 0);
  assert.equal(bs.reconciliation.difference, 0);
  assert.equal(bs.reconciliation.balanced, true, 'Opening Balance Sheet must balance exactly');

  advanceSeconds(5);

  // 2. Purchase 10 @ 120 = 1,200, Discount 100 => Grand Total 1,100 (Paid 500 Cash, Due 600)
  const pur = mustOk(ctx.createPurchase(token, {
    supplierId: sup.id, date: '2026-11-10', discount: 100, paidAmount: 500, paymentMethod: 'Cash',
    items: [{ productId: prod.id, name: 'Valve', qty: 10, unitPrice: 120, sellingPrice: 160 }]
  }));
  advanceSeconds(5);

  // 3. Purchase Return 2 units Cash (net 2 * 110 = 220 Cash back; returned discount = 20)
  mustOk(ctx.completePurchaseReturn(token, {
    purchaseId: pur.purchaseId, refundMethod: 'Cash', reason: 'Excess', date: '2026-11-10',
    items: [{ productId: prod.id, name: 'Valve', qty: 2 }]
  }));
  advanceSeconds(5);

  // 4. FIFO Cash Sale: 7 units @ 160 = 1,120 (consumes 5@100 + 2@120 = 740 COGS)
  const sale1 = mustOk(ctx.completeSale(token, {
    customerName: 'Walk-in', customerPhone: '01700000001', paymentType: 'Cash', paymentMethod: 'Cash', discount: 0,
    date: '2026-11-10', items: [{ productId: prod.id, name: 'Valve', qty: 7, unitPrice: 160, priceMode: 'manual' }]
  }));
  advanceSeconds(5);

  // 5. Damaged Sales Return: 1 unit from sale1 @ 160 Cash (no stock restored, COGS kept)
  mustOk(ctx.completeReturn(token, {
    invoiceId: sale1.invoiceId, refundMethod: 'Cash', reason: 'Cracked', date: '2026-11-10',
    items: [{ productId: prod.id, name: 'Valve', qty: 1, condition: 'Damaged' }]
  }));
  advanceSeconds(5);

  // 6. Due Sale to Rahim with Vendor Consignment shortage:
  //    Stock left = 6 units; sell 8 units @ 160 = 1,280 Due (6 own @ 120 + 2 vendor @ 130)
  mustOk(ctx.completeSale(token, {
    customerId: cust.id, customerName: 'Rahim', customerPhone: '01711111111', paymentType: 'Due', discount: 0,
    date: '2026-11-10',
    items: [{ productId: prod.id, name: 'Valve', qty: 8, unitPrice: 160, priceMode: 'manual', vendorId: vendor.id, vendorUnitCost: 130 }]
  }));
  advanceSeconds(5);

  // 7. Customer Payment with Settlement Discount: Rahim pays 1,950 Cash + 50 discount (Due drops by 2,000)
  mustOk(ctx.receivePayment(token, cust.id, 1950, 'Cash', '', 'Settled part', '2026-11-10', '', 50, 'Loyalty'));
  advanceSeconds(5);

  // 8. Supplier Payment with Settlement Discount: Pay Karim 1,920 Bank + 80 discount (Due drops by 2,000)
  mustOk(ctx.paySupplier(token, sup.id, 1920, 'Bank', bank.id, 'Part pay', '2026-11-10', '', 80, 'Early pay'));
  advanceSeconds(5);

  // 9. Operating Expense: 400 Bank
  mustOk(ctx.addExpense(token, {
    date: '2026-11-10', categoryId: cat.id, payeeId: payee.id, amount: 400, paymentMethod: 'Bank', bankAccountId: bank.id, description: 'Electric bill'
  }));
  advanceSeconds(5);

  // 10. Finance: Borrower Loan 2,000 Cash + Owner Investment 5,000 Bank
  mustOk(ctx.addFinanceTransaction(token, {
    date: '2026-11-10', transactionType: 'Borrower Loan', personId: owner.id, paymentMethod: 'Cash', amount: 2000
  }));
  mustOk(ctx.addFinanceTransaction(token, {
    date: '2026-11-10', transactionType: 'Owner Investment', personId: owner.id, paymentMethod: 'Bank', bankAccountId: bank.id, amount: 5000
  }));
  advanceSeconds(5);

  // 11. Manual Bank Interest (+150) & Bank Charge (-50) -> Net +100 bank adjustment
  mustOk(ctx.addBankManualEntry(token, {
    bankAccountId: bank.id, entryType: 'Interest Received', amount: 150, date: '2026-11-10', description: 'Quarterly interest'
  }));
  mustOk(ctx.addBankManualEntry(token, {
    bankAccountId: bank.id, entryType: 'Bank Charge', amount: 50, date: '2026-11-10', description: 'SMS fee'
  }));

  // Verify complete Balance Sheet balances to 0.00!
  bs = mustOk(ctx.getBalanceSheetReport(token));
  assert.equal(bs.assets.customerReceivable, 3280, '4000 opening + 1280 due sale - 2000 settled = 3280');
  assert.equal(bs.assets.borrowerReceivable, 2000);
  assert.equal(bs.liabilities.supplierPayable, 4600, '6000 opening + 600 purchase due - 2000 settled = 4600');
  assert.equal(bs.liabilities.vendorPayable, 260, '2 vendor units @ 130 = 260');
  assert.equal(bs.liabilities.outstandingLoan, 10000);
  assert.equal(bs.equity.ownerCapital, 73500, '68500 opening + 5000 investment');
  assert.equal(bs.equity.adjustments, 100, '+150 bank interest - 50 bank charge');
  assert.equal(bs.reconciliation.difference, 0, 'Assets MUST equal Liabilities + Equity to the paisa');
  assert.equal(bs.reconciliation.balanced, true);
  assert.equal(bs.assets.total, ctx.roundMoney_(bs.liabilities.total + bs.equity.total));

  // Verify reconciliation detects real sheet tampering (NOT a hidden plug!)
  ctx.addCashBookEntry_({
    Type: 'Unexplained Tamper', Reference: 'TEST', Description: 'Corrupt row', Debit: '', Credit: 777, PaymentMethod: 'Cash', Date: '2026-11-10'
  });
  const tamperedBs = mustOk(ctx.getBalanceSheetReport(token));
  assert.equal(tamperedBs.reconciliation.balanced, false, 'Balance Sheet must flag unexplained tampering');
  assert.equal(tamperedBs.reconciliation.difference, 777, 'Difference must report exact +777 discrepancy');
});
