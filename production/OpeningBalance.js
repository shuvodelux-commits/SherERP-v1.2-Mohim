/**
 * OpeningBalance.gs
 * ---------------------------------------------------------------------
 * High-privilege corrections for Customer / Supplier opening balances.
 * Opening balance is a signed pre-ERP baseline, not current-day turnover:
 *   Customer  + = customer owes us, - = customer advance/credit.
 *   Supplier  + = we owe supplier,   - = supplier advance/receivable.
 *
 * A correction changes the master Opening Balance and Current Due by the
 * same delta, rewrites (or creates) the Opening Balance ledger row, shifts
 * every active dependent ledger Balance by that delta, and writes a separate
 * immutable audit row. The historical Cash Book baseline is updated without
 * contributing to any current Cash Session or Day Book turnover.
 * ---------------------------------------------------------------------
 */

function parseSignedOpeningBalance_(value) {
  if (value === '' || value === null || value === undefined) return 0;
  const n = Number(value);
  if (!isFinite(n)) throw new Error('Enter a valid opening balance.');
  return roundMoney_(n);
}

function openingBalanceLedgerAmounts_(balance) {
  const amount = roundMoney_(balance);
  if (amount > 0) return { Debit: amount, Credit: '' };
  if (amount < 0) return { Debit: '', Credit: Math.abs(amount) };
  return { Debit: '', Credit: '' };
}

/**
 * Historical obligations are brought forward into the ERP cash baseline.
 * This is a migration/book-balance adjustment, NOT today's cash collection
 * or payment. Negative signed balances reverse their corresponding direction.
 *
 * The unique reference is a stable source identity, so editing the same
 * opening replaces the old effect rather than accumulating duplicates.
 */
const HISTORICAL_OPENING_CASH_TYPE = 'Historical Opening';

function historicalOpeningCashDirection_(entityType) {
  if (entityType === 'Customer' || entityType === 'Borrower') return -1;
  if (entityType === 'Supplier' || entityType === 'Lender' || entityType === 'Owner') return 1;
  throw new Error('Unsupported historical opening balance type.');
}

function historicalOpeningCashReference_(entityType, sourceId) {
  if (!String(sourceId || '').trim()) throw new Error('Historical opening source is required.');
  historicalOpeningCashDirection_(entityType);
  return 'OPEN:' + entityType + ':' + String(sourceId);
}

function historicalOpeningCashRows_(entityType, sourceId) {
  const reference = historicalOpeningCashReference_(entityType, sourceId);
  return activeRows_('CASH_BOOK').filter(function (row) {
    return row['Type'] === HISTORICAL_OPENING_CASH_TYPE && row['Reference'] === reference;
  });
}

function postHistoricalOpeningCash_(entityType, sourceId, openingBalance, displayName, date) {
  const signed = roundMoney_(parseSignedOpeningBalance_(openingBalance) *
    historicalOpeningCashDirection_(entityType));
  if (Math.abs(signed) < 0.005) return;
  if (historicalOpeningCashRows_(entityType, sourceId).length) {
    throw new Error('Historical opening cash baseline already exists for this record.');
  }
  return addCashBookEntry_({
    Type: HISTORICAL_OPENING_CASH_TYPE,
    Reference: historicalOpeningCashReference_(entityType, sourceId),
    Description: entityType + ' opening balance' + (displayName ? ' — ' + displayName : ''),
    Debit: signed < 0 ? Math.abs(signed) : '',
    Credit: signed > 0 ? signed : '',
    Date: date || new Date(),
    PaymentMethod: 'Cash'
  });
}

/** Caller owns ScriptLock. Never reverse a regular cash transaction here. */
function replaceHistoricalOpeningCash_(entityType, sourceId, openingBalance, displayName, date, actingUser, reason) {
  const rows = historicalOpeningCashRows_(entityType, sourceId);
  if (rows.length > 1) throw new Error('Duplicate historical opening cash entries require repair.');
  rows.forEach(function (row) {
    markRowDeleted_('CASH_BOOK', row._rowIndex, actingUser, reason || 'Historical opening corrected', new Date());
  });
  return postHistoricalOpeningCash_(entityType, sourceId, openingBalance, displayName, date);
}

function reverseHistoricalOpeningCash_(entityType, sourceId, actingUser, reason) {
  const rows = historicalOpeningCashRows_(entityType, sourceId);
  if (rows.length > 1) throw new Error('Duplicate historical opening cash entries require repair.');
  rows.forEach(function (row) {
    markRowDeleted_('CASH_BOOK', row._rowIndex, actingUser, reason || 'Historical opening deleted', new Date());
  });
}

function openingBalanceEntityConfig_(entityType) {
  if (entityType === 'Customer') {
    return {
      masterSheet: 'CUSTOMERS',
      ledgerSheet: 'CUSTOMER_LEDGER',
      idColumn: 'Customer ID',
      nameColumn: 'Customer Name'
    };
  }
  if (entityType === 'Supplier') {
    return {
      masterSheet: 'SUPPLIERS',
      ledgerSheet: 'SUPPLIER_LEDGER',
      idColumn: 'Supplier ID',
      nameColumn: 'Supplier Name'
    };
  }
  throw new Error('Unsupported opening-balance entity type.');
}

/**
 * Pure planning step. No sheet/property mutation happens here, so every
 * permission/reason/number check can fail before the first accounting write.
 */
function buildOpeningBalanceCorrectionPlan_(entityType, masterRow, ledgerRows, newOpeningBalance, reason, actingUser, now) {
  const cfg = openingBalanceEntityConfig_(entityType);
  const newOpening = parseSignedOpeningBalance_(newOpeningBalance);
  const oldOpening = roundMoney_(Number(masterRow['Opening Balance']) || 0);
  const delta = roundMoney_(newOpening - oldOpening);
  const currentDue = roundMoney_(Number(masterRow['Current Due']) || 0);
  const entityId = masterRow[cfg.idColumn];
  const entityName = masterRow[cfg.nameColumn] || '';

  if (Math.abs(delta) < 0.005) {
    return {
      changed: false,
      entityType: entityType,
      masterSheet: cfg.masterSheet,
      masterRowIndex: masterRow._rowIndex,
      ledgerSheet: cfg.ledgerSheet,
      masterFields: {},
      ledgerUpdates: [],
      openingLedgerInsert: null,
      delta: 0,
      newDue: currentDue,
      auditRow: null
    };
  }

  const cleanReason = sanitizeInput_(reason);
  if (!cleanReason) throw new Error('Reason is required when changing an opening balance.');

  const newDue = roundMoney_(currentDue + delta);
  const openingAmounts = openingBalanceLedgerAmounts_(newOpening);
  const activeRows = (ledgerRows || []).filter(function (row) {
    return !isDeleted_(row) && String(row[cfg.idColumn]) === String(entityId);
  });
  // Legacy/demo rows sometimes used a non-entity Reference such as DEMO.
  // The party ID plus Type is the stable identity of the opening row.
  const openingRow = activeRows.filter(function (row) {
    return row['Type'] === 'Opening Balance';
  })[0] || null;

  const ledgerUpdates = [];
  activeRows.forEach(function (row) {
    if (openingRow && row._rowIndex === openingRow._rowIndex) {
      ledgerUpdates.push({
        rowIndex: row._rowIndex,
        fields: {
          Debit: openingAmounts.Debit,
          Credit: openingAmounts.Credit,
          Balance: newOpening
        }
      });
      return;
    }
    ledgerUpdates.push({
      rowIndex: row._rowIndex,
      fields: { Balance: roundMoney_((Number(row['Balance']) || 0) + delta) }
    });
  });

  let openingLedgerInsert = null;
  if (!openingRow) {
    openingLedgerInsert = {
      'Ledger ID': '',
      Date: masterRow['Created At'] || now,
      [cfg.idColumn]: entityId,
      [cfg.nameColumn]: entityName,
      Type: 'Opening Balance',
      Reference: entityId,
      Debit: openingAmounts.Debit,
      Credit: openingAmounts.Credit,
      Balance: newOpening,
      Notes: 'Opening balance correction',
      'Created By': actorName_(actingUser),
      'Created At': now
    };
  }

  return {
    changed: true,
    entityType: entityType,
    masterSheet: cfg.masterSheet,
    masterRowIndex: masterRow._rowIndex,
    ledgerSheet: cfg.ledgerSheet,
    masterFields: {
      'Opening Balance': newOpening,
      'Current Due': newDue
    },
    ledgerUpdates: ledgerUpdates,
    openingLedgerInsert: openingLedgerInsert,
    delta: delta,
    newDue: newDue,
    auditRow: {
      'Audit ID': '',
      'Changed At': now,
      'Entity Type': entityType,
      'Entity ID': entityId,
      'Entity Name': entityName,
      'Old Opening Balance': oldOpening,
      'New Opening Balance': newOpening,
      Delta: delta,
      'Current Due Before': currentDue,
      'Current Due After': newDue,
      Reason: cleanReason,
      'Changed By': actorName_(actingUser)
    }
  };
}

/**
 * Applies one already-validated plan while the caller holds ScriptLock.
 * extraMasterFields lets Customer/Supplier profile edits and balance
 * correction share one master-row write, reducing partial-write exposure.
 */
function applyOpeningBalanceCorrectionPlan_(plan, extraMasterFields) {
  if (!plan || !plan.changed) return;

  // Validate/self-heal every required schema and read the target ledger range
  // before the first accounting mutation. Apps Script has no rollback.
  getSheetHeaders_('OPENING_BALANCE_EDIT_LOG');

  let ledgerRange = null;
  let ledgerValues = null;
  let ledgerHeaders = null;
  let ledgerMinRow = 0;
  let ledgerMinCol = 0;
  if (plan.ledgerUpdates && plan.ledgerUpdates.length) {
    const sheet = getSheet_(plan.ledgerSheet);
    ledgerHeaders = getSheetHeaders_(plan.ledgerSheet);
    const debitCol = ledgerHeaders.indexOf('Debit');
    const creditCol = ledgerHeaders.indexOf('Credit');
    const balanceCol = ledgerHeaders.indexOf('Balance');
    if (debitCol < 0 || creditCol < 0 || balanceCol < 0) {
      throw new Error('Ledger columns are missing. Run Setup / Repair System.');
    }

    const rowIndexes = plan.ledgerUpdates.map(function (u) { return u.rowIndex; });
    ledgerMinRow = Math.min.apply(null, rowIndexes);
    const maxRow = Math.max.apply(null, rowIndexes);
    ledgerMinCol = Math.min(debitCol, creditCol, balanceCol);
    const maxCol = Math.max(debitCol, creditCol, balanceCol);
    ledgerRange = sheet.getRange(ledgerMinRow, ledgerMinCol + 1, maxRow - ledgerMinRow + 1, maxCol - ledgerMinCol + 1);
    ledgerValues = ledgerRange.getValues();

    // Prepare the in-memory batch while still before the first write.
    plan.ledgerUpdates.forEach(function (update) {
      const target = ledgerValues[update.rowIndex - ledgerMinRow];
      Object.keys(update.fields).forEach(function (field) {
        const col = ledgerHeaders.indexOf(field);
        if (col >= ledgerMinCol && col <= maxCol) target[col - ledgerMinCol] = update.fields[field];
      });
    });
  }

  const masterFields = Object.assign({}, extraMasterFields || {}, plan.masterFields || {});
  updateRowFields_(plan.masterSheet, plan.masterRowIndex, masterFields);

  if (ledgerRange) {
    ledgerRange.setValues(ledgerValues);
    invalidateSheetCache_(plan.ledgerSheet);
  }

  if (plan.openingLedgerInsert) {
    const row = Object.assign({}, plan.openingLedgerInsert);
    row['Ledger ID'] = generateId_(plan.ledgerSheet);
    appendRow_(plan.ledgerSheet, row);
  }

  const auditRow = Object.assign({}, plan.auditRow);
  auditRow['Audit ID'] = generateId_('OPENING_BALANCE_EDIT_LOG');
  appendRow_('OPENING_BALANCE_EDIT_LOG', auditRow);
}

/* =====================================================================
 * PREVIEW-FIRST REPAIR TOOL FOR LEGACY "Historical Opening" CASH_BOOK ROWS
 * ---------------------------------------------------------------------
 * Earlier versions posted Customer, Supplier, Owner Capital and Loan
 * opening balances into CASH_BOOK with Type = 'Historical Opening',
 * distorting physical cash balances. Opening balances no longer touch
 * CASH_BOOK; these admin-only endpoints let the owner inspect and
 * explicitly approve soft-deleting any legacy rows already on the sheet.
 * ===================================================================== */

function planHistoricalOpeningCashRepair_() {
  const rows = activeRows_('CASH_BOOK').filter(function (row) {
    return row['Type'] === HISTORICAL_OPENING_CASH_TYPE;
  });
  const cashBalanceBefore = roundMoney_(getCashBalance_());
  let totalCashEffect = 0;
  const previewRows = rows.map(function (row) {
    const debit = roundMoney_(Number(row['Debit']) || 0);
    const credit = roundMoney_(Number(row['Credit']) || 0);
    const effect = roundMoney_(credit - debit);
    totalCashEffect = roundMoney_(totalCashEffect + effect);
    return {
      rowIndex: row._rowIndex,
      entryId: row['Entry ID'] || '',
      date: safeDateOnly_(row['Date']),
      reference: row['Reference'] || '',
      description: row['Description'] || '',
      debit: debit,
      credit: credit,
      cashAdjustment: roundMoney_(-effect)
    };
  });
  const netCashAdjustment = roundMoney_(-totalCashEffect);
  const cashBalanceAfter = roundMoney_(cashBalanceBefore + netCashAdjustment);
  return {
    rows: rows,
    previewRows: previewRows,
    rowCount: rows.length,
    cashBalanceBefore: cashBalanceBefore,
    cashBalanceAfter: cashBalanceAfter,
    netCashAdjustment: netCashAdjustment
  };
}

/** Read-only preview of legacy Historical Opening Cash Book rows to remove. */
function previewHistoricalOpeningCashRepair(token) {
  try {
    requireAdmin_(token);
    const plan = planHistoricalOpeningCashRepair_();
    return ok_({
      rowCount: plan.rowCount,
      cashBalanceBefore: plan.cashBalanceBefore,
      cashBalanceAfter: plan.cashBalanceAfter,
      netCashAdjustment: plan.netCashAdjustment,
      rows: plan.previewRows
    });
  } catch (err) {
    logError_('previewHistoricalOpeningCashRepair', err);
    return fail_(err.message);
  }
}

/** Soft-deletes legacy Historical Opening Cash Book rows after explicit approval. */
function applyHistoricalOpeningCashRepair(token, reason) {
  const lock = LockService.getScriptLock();
  lock.waitLock(CONFIG.LOCK_TIMEOUT_MS);
  try {
    const user = requireAdmin_(token);
    const cleanReason = sanitizeInput_(reason);
    if (!cleanReason) return fail_('Enter a reason before applying this repair.');

    const plan = planHistoricalOpeningCashRepair_();
    const now = new Date();
    plan.rows.forEach(function (row) {
      markRowDeleted_('CASH_BOOK', row._rowIndex, user, cleanReason, now);
    });
    if (plan.rowCount > 0) {
      logDeletion_('cashbook', 'HISTORICAL-OPENING-REPAIR', '', cleanReason + ' (' + plan.rowCount + ' row(s))', user);
    }
    const cashBalanceAfter = roundMoney_(getCashBalance_());
    return ok_({
      repairedCount: plan.rowCount,
      cashBalanceBefore: plan.cashBalanceBefore,
      cashBalanceAfter: cashBalanceAfter,
      netCashAdjustment: roundMoney_(cashBalanceAfter - plan.cashBalanceBefore),
      rows: plan.previewRows
    });
  } catch (err) {
    logError_('applyHistoricalOpeningCashRepair', err);
    return fail_(err.message);
  } finally {
    lock.releaseLock();
  }
}

/**
 * Google Sheets menu entry (Hardware ERP -> Repair Historical Opening Cash (Preview)).
 * Shows a read-only preview dialog first and only soft-deletes legacy
 * 'Historical Opening' CASH_BOOK rows after explicit YES confirmation.
 */
function runHistoricalOpeningCashRepairMenu_() {
  const ui = SpreadsheetApp.getUi();
  try {
    const plan = planHistoricalOpeningCashRepair_();
    if (!plan.rowCount) {
      ui.alert(
        'Historical Opening Cash Repair',
        'No active "Historical Opening" rows were found in Cash Book.\nCurrent Cash Balance: ' + plan.cashBalanceBefore,
        ui.ButtonSet.OK
      );
      return;
    }

    const sample = plan.previewRows.slice(0, 12).map(function (r) {
      const amt = r.credit > 0 ? ('Credit +' + r.credit) : ('Debit -' + r.debit);
      return '• ' + (r.entryId || ('Row ' + r.rowIndex)) + ' | ' + r.date + ' | ' + r.description + ' (' + amt + ')';
    });
    if (plan.rowCount > 12) sample.push('... and ' + (plan.rowCount - 12) + ' more row(s).');

    const msg =
      'Found ' + plan.rowCount + ' legacy "Historical Opening" row(s) in Cash Book:\n\n' +
      sample.join('\n') + '\n\n' +
      'Cash Balance Before: ' + plan.cashBalanceBefore + '\n' +
      'Net Cash Adjustment: ' + plan.netCashAdjustment + '\n' +
      'Cash Balance After:  ' + plan.cashBalanceAfter + '\n\n' +
      'Do you want to soft-delete these rows now? (No rows are permanently erased.)';

    const answer = ui.alert('Preview: Historical Opening Cash Repair', msg, ui.ButtonSet.YES_NO);
    if (answer !== ui.Button.YES) {
      ui.alert('Cancelled', 'No changes were made.', ui.ButtonSet.OK);
      return;
    }

    const lock = LockService.getScriptLock();
    lock.waitLock(CONFIG.LOCK_TIMEOUT_MS);
    try {
      const freshPlan = planHistoricalOpeningCashRepair_();
      const now = new Date();
      const reason = 'Sheet menu Historical Opening Cash repair (approved after preview)';
      const ownerActor = { 'Full Name': 'Sheet Owner', 'Mobile Number': '' };
      freshPlan.rows.forEach(function (row) {
        markRowDeleted_('CASH_BOOK', row._rowIndex, ownerActor, reason, now);
      });
      if (freshPlan.rowCount > 0) {
        logDeletion_('cashbook', 'HISTORICAL-OPENING-REPAIR', '', reason + ' (' + freshPlan.rowCount + ' row(s))', ownerActor);
      }
      SpreadsheetApp.flush();
      const afterBalance = roundMoney_(getCashBalance_());
      ui.alert(
        'Repair Complete',
        'Soft-deleted ' + freshPlan.rowCount + ' Historical Opening row(s).\n' +
        'Cash Balance Before: ' + freshPlan.cashBalanceBefore + '\n' +
        'Cash Balance After:  ' + afterBalance,
        ui.ButtonSet.OK
      );
    } finally {
      lock.releaseLock();
    }
  } catch (err) {
    logError_('runHistoricalOpeningCashRepairMenu_', err);
    ui.alert('Repair Failed', err.message, ui.ButtonSet.OK);
  }
}
