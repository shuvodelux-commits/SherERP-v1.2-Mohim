/**
 * Dashboard.gs
 * ---------------------------------------------------------------------
 * Lightweight operational dashboard only. Detailed analysis belongs in
 * Reports. The endpoint intentionally reads only the sheets needed for
 * the daily/operational cards shown on Dashboard.
 */

/**
 * Net revenue for the supplied invoice rows, using the same economic return
 * value rule as Reports -> Profit. This keeps Today Sales return-aware
 * without invoking FIFO COGS/profit aggregation.
 */
function dashboardTodayNetSales_(sales) {
  if (!sales || !sales.length) return 0;
  const saleByInvoice = {};
  let grossSales = 0;
  (sales || []).forEach(function (s) {
    saleByInvoice[s['Invoice ID']] = s;
    grossSales += Number(s['Grand Total']) || 0;
  });

  let returnedTotal = 0;
  activeSalesReturnItems_().forEach(function (ri) {
    const parent = saleByInvoice[ri['Invoice ID']];
    if (!parent) return;
    returnedTotal += economicReturnLineAmount_(ri, parent['Subtotal'], parent['Grand Total']);
  });

  return roundMoney_(grossSales - returnedTotal);
}

/** Actual customer money received today: POS paid amounts plus later cash/bank
 * customer payments, net of Cash sales refunds and customer advance refunds.
 * Non-cash payment methods (e.g. 'Other') and settlement discounts are excluded.
 */
function dashboardTodayCollection_(todaySales, customerLedgerRows, today, salesReturns) {
  let total = (todaySales || []).reduce(function (sum, sale) {
    return sum + Math.max(0, Number(sale['Paid Amount']) || 0);
  }, 0);

  (customerLedgerRows || []).forEach(function (row) {
    if (safeDateOnly_(row['Date']) !== today) return;
    const method = row['Payment Method'];
    const isCashBacked = typeof customerSettlementIsCashBackedMethod_ === 'function'
      ? customerSettlementIsCashBackedMethod_(method)
      : (!method || method === 'Cash' || method === 'Bank' || method === 'Mobile Banking');
    if (!isCashBacked) return;

    if (row['Type'] === 'Payment') {
      const rawPayment = row['Payment Amount'];
      let money;
      if (rawPayment !== '' && rawPayment !== null && rawPayment !== undefined) {
        money = Number(rawPayment) || 0;
      } else {
        money = (Number(row['Credit']) || 0) - (Number(row['Discount Amount']) || 0);
      }
      total += Math.max(0, money);
    } else if (row['Type'] === 'Advance Refund') {
      const refund = Number(row['Debit']) || Number(row['Payment Amount']) || 0;
      total -= Math.max(0, refund);
    }
  });

  (salesReturns || []).forEach(function (ret) {
    if (safeDateOnly_(ret['Date']) !== today) return;
    if (ret['Refund Method'] === 'Cash' || isBankLikePaymentMethod_(ret['Refund Method'])) {
      total -= Math.max(0, Number(ret['Total Return Amount']) || 0);
    }
  });

  return roundMoney_(total);
}

function dashboardTodayExpense_(rows, today) {
  return roundMoney_((rows || []).reduce(function (sum, row) {
    if (safeDateOnly_(row['Date']) !== today || row['Status'] === 'Cancelled') return sum;
    return sum + (Number(row['Amount']) || 0);
  }, 0));
}

function dashboardTodayPurchase_(rows, today) {
  const todayPurchases = (rows || []).filter(function (row) {
    return safeDateOnly_(row['Date']) === today;
  });
  if (!todayPurchases.length) return 0;
  const purchaseById = {};
  let gross = 0;
  todayPurchases.forEach(function (p) {
    purchaseById[p['Purchase ID']] = p;
    gross += Number(p['Grand Total']) || 0;
  });
  let returned = 0;
  activePurchaseReturnItems_().forEach(function (ri) {
    const parent = purchaseById[ri['Purchase ID']];
    if (!parent) return;
    returned += economicReturnLineAmount_(ri, parent['Subtotal'], parent['Grand Total']);
  });
  return roundMoney_(gross - returned);
}

function getDashboardStats(token) {
  try {
    requirePermission_(token, 'dashboard', 'view');
    const today = formatDate_(new Date());

    const sales = activeRows_('SALES');
    const todaySales = sales.filter(function (s) {
      return safeDateOnly_(s['Date']) === today;
    });
    assertUniqueSalesInvoiceIds_(todaySales, 'Dashboard today sales', sales);

    const todaySalesTotal = dashboardTodayNetSales_(todaySales);
    const todayCollectionTotal = dashboardTodayCollection_(todaySales, activeRows_('CUSTOMER_LEDGER'), today, activeRows_('SALES_RETURN'));
    const todayExpenseTotal = dashboardTodayExpense_(activeRows_('EXPENSES'), today);
    const todayPurchaseTotal = dashboardTodayPurchase_(activeRows_('PURCHASES'), today);

    const dueReceivable = activeRows_('CUSTOMERS').reduce(function (sum, c) {
      return sum + Math.max(0, Number(c['Current Due']) || 0);
    }, 0);

    const supplierPayable = activeRows_('SUPPLIERS').reduce(function (sum, s) {
      return sum + Math.max(0, Number(s['Current Due']) || 0);
    }, 0);

    const lowStockCount = activeRows_('PRODUCTS').reduce(function (count, p) {
      if (p['Status'] === 'Inactive') return count;
      if (bundleProductType_(p) === 'Bundle') return count;
      return count + (Number(p['Current Stock']) <= Number(p['Minimum Stock']) ? 1 : 0);
    }, 0);

    // Reuse the Finance module's signed per-person balance logic so Dashboard
    // always matches Business Finance after repayments, credits, edits or deletes.
    const financeSummary = financeBalanceSummary_(activeRows_('FINANCE_TRANSACTIONS'));
    const settings = getSettingsMap_();

    return ok_({
      todaySalesTotal: todaySalesTotal,
      todayCollectionTotal: todayCollectionTotal,
      todayExpenseTotal: todayExpenseTotal,
      todayPurchaseTotal: todayPurchaseTotal,
      dueReceivable: roundMoney_(dueReceivable),
      borrowerReceivable: financeSummary.borrowerReceivable,
      supplierPayable: roundMoney_(supplierPayable),
      outstandingLoan: financeSummary.outstandingLoan,
      cashBalance: getCashBalance_(),
      lowStockCount: lowStockCount,
      currencySymbol: settings['Currency Symbol'] || ''
    });
  } catch (err) {
    logError_('getDashboardStats', err);
    return fail_(err.message);
  }
}
