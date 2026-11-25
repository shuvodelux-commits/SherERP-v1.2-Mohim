/**
 * StockLots.gs
 * ---------------------------------------------------------------------
 * Lot/Batch inventory layer sitting underneath Products.Current Stock.
 * Every purchase line creates its own Stock Lot (own Purchase Price, own
 * Remaining Quantity); sales/adjustments/returns consume or restore
 * specific lots via the helpers below instead of ever touching a single
 * pooled number. Products.Current Stock stays a fast-read cache exactly
 * like before — every caller of these helpers is still responsible for
 * updating it, so every existing screen that reads Current Stock keeps
 * working unchanged (POS grid, Dashboard, low-stock, etc).
 *
 * Review item 10: the client-reachable functions here now require a
 * session token. Apps Script exposes every global function without a
 * trailing underscore to google.script.run, so an ungated one is
 * reachable by anyone holding the web app URL.
 *
 * getProductLots exposed per-lot purchase prices - your cost basis - to
 * anyone with the URL. It now checks 'products':'view'.
 *
 * Review item 12 / P0 #8: consumeStockFIFO_ used to decide AND write in
 * one pass, which made "validate everything before writing anything"
 * impossible for its callers — by the time you knew line 3 was short,
 * lines 1 and 2 had already been drawn down. It is now split into
 * planStockConsumption_ (decides, writes nothing) and
 * applyStockConsumption_ (writes a plan). consumeStockFIFO_ remains as a
 * plan-then-apply wrapper with its original signature and return shape,
 * so Products.adjustStock and SalesManagement.updateSale are untouched.
 *
 * Review item 11 / P0 #7: FIFO consumed lots in 'Created At' order —
 * when the row was WRITTEN. Purchase.gs also stamped the lot's Purchase
 * Date with now() rather than the purchase's own date. So a purchase
 * backdated to last month became the NEWEST lot and FIFO consumed it
 * last, which quietly corrupts cost of goods sold and inventory
 * valuation. Both now use the real purchase date, with Lot ID as a
 * stable tiebreak for lots bought the same day (IDs are zero-padded, so
 * string order is creation order).
 *
 * P3 drift (items 8 & 10): getProductLots() now returns an explicit
 * shape instead of raw sheet rows (which leaked the internal _rowIndex
 * to the browser — every other read endpoint in the app maps its
 * output). consumeStockFIFO_'s LEGACY back-fill no longer re-finds a
 * row it just wrote: createLot_ delegates to createLotWithRow_, which
 * hands back the row index appendRow_ already returned.
 * ---------------------------------------------------------------------
 */

/**
 * FIFO ordering: oldest PURCHASE first, not oldest write. Lot ID breaks
 * ties for same-day purchases — IDs are zero-padded (LOT-000001) so
 * lexicographic order is creation order.
 *
 * Falls back to Created At when a lot has no Purchase Date, which covers
 * rows written before this change.
 */
function compareLotsFifo_(a, b) {
  const da = safeDateOnly_(a['Purchase Date']) || safeDateOnly_(a['Created At']) || '';
  const db = safeDateOnly_(b['Purchase Date']) || safeDateOnly_(b['Created At']) || '';
  if (da !== db) return da < db ? -1 : 1;
  return String(a['Lot ID']).localeCompare(String(b['Lot ID']));
}

/**
 * Returns a lot's own selling price. Legacy lots written before the Sell
 * Price column existed fall back to the product's current/default Selling
 * Price so POS remains usable before the one-time backfill is run.
 */
function lotSellPrice_(lot, productRow) {
  const raw = lot ? lot['Sell Price'] : '';
  if (raw !== '' && raw !== null && raw !== undefined && isValidNonNegativeNumber_(raw)) {
    return Number(raw);
  }
  const fallback = productRow ? productRow['Selling Price'] : 0;
  return isValidNonNegativeNumber_(fallback) ? Number(fallback) : 0;
}

/**
 * Compact FIFO pricing ladder for POS. Adjacent lots with the same sell
 * price are merged so bootstrap payload size grows with price changes, not
 * with every purchase row. Uses the exact same compareLotsFifo_ ordering as
 * stock consumption.
 */
function buildLotPricingLadder_(productId, allLots, productRow) {
  const fallbackSellPrice = lotSellPrice_(null, productRow);
  const lots = (allLots || [])
    .filter(function (l) {
      return l['Product ID'] === productId && (Number(l['Remaining Quantity']) || 0) > 0 && l['Status'] !== 'Deleted';
    })
    .sort(compareLotsFifo_);
  const segments = [];
  lots.forEach(function (lot) {
    const qty = Number(lot['Remaining Quantity']) || 0;
    if (qty <= 0) return;
    const sellPrice = lotSellPrice_(lot, productRow);
    const prev = segments.length ? segments[segments.length - 1] : null;
    if (prev && Math.abs(prev.sellPrice - sellPrice) < 0.0000001) prev.qty += qty;
    else segments.push({ qty: qty, sellPrice: sellPrice });
  });
  return {
    segments: segments,
    fallbackSellPrice: fallbackSellPrice,
    autoSellingPrice: segments.length ? segments[0].sellPrice : fallbackSellPrice
  };
}

/**
 * Server-authoritative automatic sale pricing for a FIFO consumption plan.
 * Unit Price is the 2-decimal display average; Line Total is the exact
 * 2-decimal sum of lot sell-price allocations, so 1-paisa rounding drift
 * cannot accumulate when an average has more than two decimals.
 */
function computePlanSellingPrice_(plan, qty) {
  let total = 0;
  (plan.draws || []).forEach(function (d) {
    total += (Number(d.take) || 0) * (Number(d.unitSellPrice) || 0);
  });
  if ((Number(plan.shortfall) || 0) > 0) {
    total += (Number(plan.shortfall) || 0) * (Number(plan.fallbackSellPrice) || 0);
  }
  const lineTotal = roundMoney_(total);
  const quantity = Number(qty) || 0;
  return {
    unitPrice: quantity > 0 ? roundMoney_(lineTotal / quantity) : 0,
    lineTotal: lineTotal
  };
}

/**
 * Creates one lot row and returns { id, rowIndex }. appendRow_ already
 * hands back the sheet row it wrote, so a caller that needs to amend the
 * row it just created never has to search for it again.
 */
function createLotWithRow_(productId, productName, purchaseId, purchaseDate, purchasePrice, qty, supplierId, supplierName, sellPrice) {
  assertPositiveInternalLotCost_(purchaseId, qty, purchasePrice);
  let resolvedSellPrice = sellPrice;
  if (!isValidNonNegativeNumber_(resolvedSellPrice)) {
    const product = getAllRows_('PRODUCTS').filter(function (p) { return p['Product ID'] === productId; })[0];
    resolvedSellPrice = product ? Number(product['Selling Price']) || 0 : 0;
  }
  const id = generateId_('STOCK_LOTS');
  const rowIndex = appendRow_('STOCK_LOTS', {
    'Lot ID': id, 'Product ID': productId, 'Product Name': productName,
    'Purchase ID': purchaseId, 'Purchase Date': purchaseDate,
    'Purchase Price': Number(purchasePrice) || 0, 'Sell Price': Number(resolvedSellPrice) || 0,
    'Original Quantity': Number(qty) || 0, 'Remaining Quantity': Number(qty) || 0,
    'Status': 'Active', 'Created At': new Date(),
    'Supplier ID': supplierId || '', 'Supplier Name': supplierName || ''
  });
  return { id: id, rowIndex: rowIndex };
}

/**
 * Creates one lot row. Returns the new Lot ID. supplierId/supplierName are
 * optional and trailing (blank for adjustment/legacy/opening-migration
 * lots, which have no single supplier) so every caller from before
 * multi-supplier stock keeps working unchanged.
 */
function createLot_(productId, productName, purchaseId, purchaseDate, purchasePrice, qty, supplierId, supplierName, sellPrice) {
  return createLotWithRow_(productId, productName, purchaseId, purchaseDate, purchasePrice, qty, supplierId, supplierName, sellPrice).id;
}

/**
 * Draws `qty` units of productId out of its lots, oldest lot first (FIFO).
 * Mutates each drawn-from lot's Remaining Quantity immediately. Does NOT
 * touch Products.Current Stock or write Stock Movement rows — the caller
 * (which already knows the pre-write Current Stock and reference/type,
 * same as the pre-lot code) does that, so batched appends stay intact.
 *
 * Self-healing: if the product's lots don't add up to `qty` (legacy data
 * from before the lot system / before migrateOpeningStockLots ran), the
 * shortfall is recorded as an "OVERSOLD" negative lot at the product's
 * on-file Purchase Price instead of blocking the sale — same spirit as
 * getSheetHeaders_ self-healing missing columns.
 *
 * Returns [{ lotId, qty, unitCost }, ...] — one entry per lot drawn from.
 *
 * FIFO always runs across every supplier lot for the product.
 */
function consumeStockFIFO_(productId, qty, txDate) {
  return applyStockConsumption_(planStockConsumption_(productId, qty), txDate);
}

/** Remaining own-stock effect of an invoice, already net of returns.
 * Sourcing ledger rows can be edited/deleted independently of the sale, so
 * their current quantity must never determine stock reversal quantities.
 * A sourcing history with no lot consumption means a fully vendor line.
 * Only pre-lot sales with neither kind of evidence use the legacy fallback.
 */
/**
 * One-time/idempotent repair for historical SALE_ITEM_LOTS rows created
 * before Supplier ID was declared in CONFIG.HEADERS. Existing non-blank
 * values are authoritative and never overwritten.
 */
function repairSaleItemLotSupplierIds_() {
  const lotsById = {};
  getAllRows_('STOCK_LOTS').forEach(function (lot) {
    lotsById[String(lot['Lot ID'] || '')] = lot;
  });

  let scanned = 0;
  let repaired = 0;
  let unresolved = 0;

  getAllRows_('SALE_ITEM_LOTS').forEach(function (row) {
    scanned++;
    if (String(row['Supplier ID'] || '').trim()) return;
    const lot = lotsById[String(row['Lot ID'] || '')];
    const supplierId = lot ? String(lot['Supplier ID'] || '').trim() : '';
    if (!supplierId) {
      unresolved++;
      return;
    }
    updateRowFields_('SALE_ITEM_LOTS', row._rowIndex, { 'Supplier ID': supplierId });
    repaired++;
  });

  return { scanned: scanned, repaired: repaired, unresolved: unresolved };
}

function outstandingSaleOwnStockByProduct_(invoiceId, saleItems, returnItems, consumptionRows, vendorSourcingRows) {
  const quantities = {};
  const evidenced = {};
  (consumptionRows || getAllRows_('SALE_ITEM_LOTS')).forEach(function (row) {
    if (row['Invoice ID'] !== invoiceId) return;
    const key = row['Product ID'];
    evidenced[key] = true;
    quantities[key] = (quantities[key] || 0) + Math.max(0, Number(row['Quantity']) || 0);
  });
  (vendorSourcingRows || getAllRows_('VENDOR_SOURCING')).forEach(function (row) {
    if (row['Invoice ID'] !== invoiceId) return;
    const key = row['Product ID'];
    evidenced[key] = true;
    quantities[key] = quantities[key] || 0;
  });
  (saleItems || []).forEach(function (row) {
    const key = row['Product ID'];
    if (!evidenced[key]) quantities[key] = (quantities[key] || 0) + (Number(row['Quantity']) || 0);
  });
  (returnItems || []).forEach(function (row) {
    const key = row['Product ID'];
    const qty = Number(row['Return Quantity']) || 0;
    if (!evidenced[key]) {
      quantities[key] = Math.max(0, (quantities[key] || 0) - qty);
    } else if (String(row['Condition'] || '').trim().toLowerCase() === 'damaged') {
      // Damaged returns intentionally leave SALE_ITEM_LOTS.Quantity unchanged
      // (preserving COGS loss), so subtract them from own-stock returnable qty.
      quantities[key] = Math.max(0, (quantities[key] || 0) - qty);
    }
  });
  return quantities;
}

/**
 * Decides which lots would satisfy `qty`, and WRITES NOTHING. This is the
 * half a caller runs during validation, so it can find out that line 3 is
 * short before line 1 has been touched.
 *
 * Pass `allLots` (one getAllRows_('STOCK_LOTS')) when planning several
 * products in a row, otherwise each call re-reads the whole sheet.
 *
 * Returns { productId, draws: [{ lotId, rowIndex, take, unitCost,
 * remainingAfter }], shortfall, fallbackPrice, fallbackName }.
 */
function isOpeningOrLegacyLot_(lot) {
  const src = String((lot && lot['Purchase ID']) || '').trim().toUpperCase();
  return src === 'OPENING' || src === 'OPENING-MIGRATION' || src === 'LEGACY' || src.indexOf('OPENING-') === 0;
}

function lotDateOnly_(lot) {
  return safeDateOnly_(lot['Purchase Date']) || safeDateOnly_(lot['Created At']) || '';
}

function planStockConsumption_(productId, qty, allLots, productRow, asOfDate) {
  let need = Number(qty) || 0;
  const product = productRow || getAllRows_('PRODUCTS').filter(function (p) { return p['Product ID'] === productId; })[0];
  const cutoffDate = asOfDate ? safeDateOnly_(asOfDate) : '';
  const plan = {
    productId: productId, draws: [], shortfall: 0,
    eligibleAvailable: 0, futureLotCount: 0, earliestFutureLotDate: '',
    fallbackPrice: 0,
    fallbackSellPrice: product ? Number(product['Selling Price']) || 0 : 0,
    fallbackName: product ? product['Product Name'] : ''
  };
  if (need <= 0) return plan;

  const positiveLots = (allLots || getAllRows_('STOCK_LOTS'))
    .filter(function (l) {
      return l['Product ID'] === productId && (Number(l['Remaining Quantity']) || 0) > 0 &&
        String(l['Status'] || '').toLowerCase() !== 'deleted';
    })
    .sort(compareLotsFifo_);

  const lots = [];
  positiveLots.forEach(function (l) {
    if (cutoffDate && !isOpeningOrLegacyLot_(l)) {
      const ld = lotDateOnly_(l);
      if (ld && ld > cutoffDate) {
        plan.futureLotCount++;
        if (!plan.earliestFutureLotDate || ld < plan.earliestFutureLotDate) {
          plan.earliestFutureLotDate = ld;
        }
        return;
      }
    }
    plan.eligibleAvailable += Number(l['Remaining Quantity']) || 0;
    lots.push(l);
  });

  for (let i = 0; i < lots.length && need > 0; i++) {
    const lot = lots[i];
    const available = Number(lot['Remaining Quantity']) || 0;
    const take = Math.min(available, need);
    if (take <= 0) continue;
    plan.draws.push({
      lotId: lot['Lot ID'],
      rowIndex: lot._rowIndex,
      take: take,
      unitCost: Number(lot['Purchase Price']) || 0,
      unitSellPrice: lotSellPrice_(lot, product),
      remainingAfter: available - take
    });
    need -= take;
  }

  if (need > 0) {
    // Provisional cost of the oversold units: the latest real lot's cost, not
    // the product's (often stale/opening) Purchase Price. settleOversoldLots_
    // re-costs it to the restock price when stock arrives.
    plan.fallbackPrice = latestKnownLotCost_(productId, allLots, product);
    // The product does not have enough physical stock. POS deliberately allows
    // selling past zero, so the shortfall becomes an OVERSOLD lot.
    // zero (see completeSale/updateSale). Recorded as a shortfall now;
    // applyStockConsumption_ back-fills a lot rather than blocking the sale.
    plan.shortfall = need;
  }
  return plan;
}

/**
 * Blocks a backdated sale when on-or-before-date lots cannot satisfy it while
 * newer purchase lots already exist (preventing future-lot consumption or
 * coexisting negative/positive lots).
 */
function assertSalePlanChronology_(plan, productName, saleDate) {
  if (!plan || !saleDate) return;
  if ((Number(plan.shortfall) || 0) > 0 && (Number(plan.futureLotCount) || 0) > 0) {
    const avail = Number(plan.eligibleAvailable) || 0;
    const label = productName || plan.fallbackName || plan.productId;
    throw new Error(
      label + ': cannot backdate sale to ' + saleDate + ' — only ' + avail +
      ' unit(s) were in stock on or before that date, and later purchase lots (earliest ' +
      plan.earliestFutureLotDate + ') already exist.'
    );
  }
}

/**
 * Blocks a backdated purchase (or stock addition to an older purchase) when a
 * newer non-opening lot for the same product has already been consumed by an
 * active sale, which would silently invalidate that sale's FIFO COGS.
 */
function assertPurchaseChronologicalFifo_(productId, productName, purchaseDate, allLots, allSaleItemLots, activeSalesById) {
  const pDate = safeDateOnly_(purchaseDate);
  if (!pDate) return;
  const lots = allLots || getAllRows_('STOCK_LOTS');
  const newerLotDateById = {};
  let hasNewerLot = false;
  lots.forEach(function (l) {
    if (l['Product ID'] !== productId) return;
    if (String(l['Status'] || '').toLowerCase() === 'deleted') return;
    if (String(l['Purchase ID'] || '').trim().toUpperCase() === 'OVERSOLD') return;
    if (isOpeningOrLegacyLot_(l)) return;
    const ld = lotDateOnly_(l);
    if (ld && ld > pDate) {
      newerLotDateById[String(l['Lot ID'])] = ld;
      hasNewerLot = true;
    }
  });
  if (!hasNewerLot) return;

  let salesMap = activeSalesById;
  if (!salesMap) {
    salesMap = {};
    activeRows_('SALES').forEach(function (s) { salesMap[String(s['Invoice ID'])] = s; });
  }
  const silRows = allSaleItemLots || getAllRows_('SALE_ITEM_LOTS');
  for (let i = 0; i < silRows.length; i++) {
    const row = silRows[i];
    if (row['Product ID'] !== productId) continue;
    if ((Number(row['Quantity']) || 0) <= 0) continue;
    const lotDate = newerLotDateById[String(row['Lot ID'] || '')];
    if (!lotDate) continue;
    if (!salesMap[String(row['Invoice ID'] || '')]) continue;
    throw new Error(
      (productName || productId) + ': cannot backdate purchase to ' + pDate +
      ' because newer stock lot dated ' + lotDate + ' was already sold on invoice ' +
      row['Invoice ID'] + ' (FIFO chronology guard).'
    );
  }
}

/**
 * Sale-only planner for a line whose shortage is being sourced from a vendor.
 *
 * Positive lots can temporarily exceed Products.Current Stock when earlier
 * OVERSOLD debt is still present and a later Sales Return/Purchase created
 * positive lots that offset that debt. A vendor shortage must therefore be
 * based on NET shop-owned stock, not the sum of positive lots alone.
 *
 * This deliberately does not replace planStockConsumption_ globally: negative
 * stock sales, returns, purchase returns, delete/reversal and other inventory
 * flows keep their existing lot semantics.
 */
function planSaleVendorConsumption_(productId, qty, allLots, productRow, asOfDate) {
  const requested = Number(qty) || 0;
  const product = productRow || getAllRows_('PRODUCTS').filter(function (p) { return p['Product ID'] === productId; })[0];
  if (requested <= 0) return planStockConsumption_(productId, 0, allLots, product, asOfDate);

  const netOwnedAvailable = Math.max(0, product ? (Number(product['Current Stock']) || 0) : 0);
  const ownTarget = Math.min(requested, netOwnedAvailable);
  const plan = planStockConsumption_(productId, ownTarget, allLots, product, asOfDate);
  const ownDrawn = plan.draws.reduce(function (sum, d) { return sum + (Number(d.take) || 0); }, 0);

  // Any part of the requested sale that cannot be backed by the shop's NET
  // owned stock is the vendor shortage. Do not leave planStockConsumption_'s
  // own shortfall here: completeSale/updateSale will neutralize this amount
  // into VENDOR_SOURCING before applyStockConsumption_ writes anything.
  plan.shortfall = Math.max(0, requested - ownDrawn);
  return plan;
}


/**
 * Cost of the most recent real lot for a product: the newest non-deleted,
 * non-OVERSOLD lot with a positive cost, in the same FIFO date order used for
 * consumption. Falls back to the product's on-file Purchase Price only when
 * the product has no such lot. This is the provisional cost of oversold units.
 */
function latestKnownLotCost_(productId, allLots, productRow) {
  const real = (allLots || getAllRows_('STOCK_LOTS')).filter(function (l) {
    if (l['Product ID'] !== productId) return false;
    if (String(l['Purchase ID'] || '').toUpperCase() === 'OVERSOLD') return false;
    if (String(l['Status'] || '').toLowerCase() === 'deleted') return false;
    return (Number(l['Purchase Price']) || 0) > 0;
  }).sort(compareLotsFifo_);
  // Prefer the latest real purchase / adjustment / opening lot. Returned-stock
  // and delete-restore lots only carry an old sale cost, so they are used
  // only when the product has no real purchase lot at all.
  const inbound = real.filter(function (l) { return isInboundLotSource_(l['Purchase ID']); });
  const pool = inbound.length ? inbound : real;
  if (pool.length) return Number(pool[pool.length - 1]['Purchase Price']) || 0;
  return productRow ? (Number(productRow['Purchase Price']) || 0) : 0;
}

/**
 * Cost POS should show: the next lot FIFO will actually consume. When no lot
 * has stock (stock zero or negative) it is the latest known lot cost.
 */
function nextLotCost_(productId, allLots, productRow) {
  const next = (allLots || getAllRows_('STOCK_LOTS')).filter(function (l) {
    return l['Product ID'] === productId && (Number(l['Remaining Quantity']) || 0) > 0 &&
      String(l['Status'] || '').toLowerCase() !== 'deleted';
  }).sort(compareLotsFifo_)[0];
  if (next && (Number(next['Purchase Price']) || 0) > 0) return Number(next['Purchase Price']);
  return latestKnownLotCost_(productId, allLots, productRow);
}

/** Re-costs every sale-consumption row of a lot (this is what COGS reports read). */
function recostSaleItemLots_(lotId, unitCost, saleItemLots) {
  let changed = 0;
  (saleItemLots || getAllRows_('SALE_ITEM_LOTS')).forEach(function (row) {
    if (String(row['Lot ID'] || '') !== String(lotId)) return;
    if (Math.abs((Number(row['Unit Cost']) || 0) - unitCost) < 0.0000001) return;
    updateRowFields_('SALE_ITEM_LOTS', row._rowIndex, { 'Unit Cost': unitCost });
    row['Unit Cost'] = unitCost;
    changed++;
  });
  return changed;
}

/**
 * Stock coming in (purchase, adjustment, return) pays off oversold debt
 * first. Walks the product's negative lots oldest-first, adds up to `qty`
 * back to them, and moves/splits the settled slice of SALE_ITEM_LOTS rows
 * onto the settling inbound lot at `unitCost` (recording Settled From Lot ID).
 * Unsettled slices remain on the OVERSOLD lot at provisional cost so partial
 * settlement across multiple purchases at different prices never overwrites
 * earlier or remaining slices.
 * Returns { absorbed, lotIds, entries }. `qty - absorbed` is what is left to stock.
 */
function settleOversoldLots_(productId, qty, unitCost, allLots, saleItemLots, settlingLot) {
  let available = Number(qty) || 0;
  const result = { absorbed: 0, lotIds: [], entries: [] };
  const cost = Number(unitCost) || 0;
  if (available <= 0) return result;
  const lots = (allLots || getAllRows_('STOCK_LOTS')).filter(function (l) {
    return l['Product ID'] === productId && (Number(l['Remaining Quantity']) || 0) < 0 &&
      String(l['Status'] || '').toLowerCase() !== 'deleted';
  }).sort(compareLotsFifo_);
  const sales = saleItemLots || (lots.length ? getAllRows_('SALE_ITEM_LOTS') : []);
  lots.forEach(function (lot) {
    if (available <= 0) return;
    const remaining = Number(lot['Remaining Quantity']) || 0;
    const take = Math.min(-remaining, available);
    const after = remaining + take;
    const prevCost = Number(lot['Purchase Price']) || 0;
    const fields = { 'Remaining Quantity': after, 'Status': after < 0 ? 'Oversold' : 'Settled' };
    // Preserve provisional Purchase Price on partially-settled OVERSOLD lots
    // so subsequent settling purchases record the original provisional prevCost.
    if (after === 0 && cost > 0 && !(settlingLot && settlingLot.id)) {
      fields['Purchase Price'] = cost;
    }
    updateRowFields_('STOCK_LOTS', lot._rowIndex, fields);
    lot['Remaining Quantity'] = after;
    lot['Status'] = fields['Status'];
    if (fields['Purchase Price'] !== undefined) lot['Purchase Price'] = fields['Purchase Price'];

    if (settlingLot && settlingLot.id) {
      let toMove = take;
      const matchingRows = sales.filter(function (row) {
        return String(row['Lot ID'] || '') === String(lot['Lot ID']) && (Number(row['Quantity']) || 0) > 0;
      }).sort(function (a, b) { return (a._rowIndex || 0) - (b._rowIndex || 0); });

      for (let i = 0; i < matchingRows.length && toMove > 0; i++) {
        const row = matchingRows[i];
        const rowQty = Number(row['Quantity']) || 0;
        const slice = Math.min(rowQty, toMove);
        if (slice <= 0) continue;
        const nextCost = cost > 0 ? cost : (Number(row['Unit Cost']) || 0);
        const nextSupplier = (settlingLot.supplierId !== undefined && settlingLot.supplierId !== '')
          ? settlingLot.supplierId : (row['Supplier ID'] || '');

        if (Math.abs(slice - rowQty) < 1e-8) {
          updateRowFields_('SALE_ITEM_LOTS', row._rowIndex, {
            'Lot ID': settlingLot.id,
            'Unit Cost': nextCost,
            'Supplier ID': nextSupplier,
            'Settled From Lot ID': lot['Lot ID']
          });
          row['Lot ID'] = settlingLot.id;
          row['Unit Cost'] = nextCost;
          row['Supplier ID'] = nextSupplier;
          row['Settled From Lot ID'] = lot['Lot ID'];
        } else {
          const remainQty = rowQty - slice;
          updateRowFields_('SALE_ITEM_LOTS', row._rowIndex, { 'Quantity': remainQty });
          row['Quantity'] = remainQty;
          const splitRow = {
            'Invoice ID': row['Invoice ID'],
            'Product ID': row['Product ID'],
            'Lot ID': settlingLot.id,
            'Quantity': slice,
            'Unit Cost': nextCost,
            'Unit Sell Price': row['Unit Sell Price'],
            'Created At': row['Created At'] || new Date(),
            'Supplier ID': nextSupplier,
            'Source Sale Product ID': row['Source Sale Product ID'] || row['Product ID'],
            'Return Consumption Link ID': '',
            'Settled From Lot ID': lot['Lot ID']
          };
          const newIdx = appendRow_('SALE_ITEM_LOTS', splitRow);
          splitRow._rowIndex = newIdx;
          sales.push(splitRow);
        }
        toMove -= slice;
      }
    } else if (cost > 0) {
      recostSaleItemLots_(lot['Lot ID'], cost, sales);
    }

    available -= take;
    result.absorbed += take;
    result.lotIds.push(lot['Lot ID']);
    result.entries.push({ lotId: lot['Lot ID'], qty: take, prevCost: prevCost });
  });
  return result;
}

/** "LOT-1:229:68|LOT-2:1:68" <-> [{lotId, qty, prevCost}] */
function parseSettlementLog_(text) {
  return String(text || '').split('|').map(function (part) {
    const f = part.split(':');
    if (f.length < 3 || !f[0]) return null;
    const qty = Number(f[1]);
    return qty > 0 ? { lotId: f[0], qty: qty, prevCost: Number(f[2]) || 0 } : null;
  }).filter(function (e) { return !!e; });
}
function formatSettlementLog_(entries) {
  return (entries || []).filter(function (e) { return e.qty > 0; }).map(function (e) {
    return e.lotId + ':' + e.qty + ':' + e.prevCost;
  }).join('|');
}

/**
 * Trims up to `qty` units for `targetOversoldLotId` from an inbound lot's
 * Settlement Log (newest matching entry first). Called when a previously
 * settled sale slice is returned or deleted so the inbound lot's remaining
 * stock and settlement log never double-count the same units.
 */
function trimLotSettlementLog_(lotRow, targetOversoldLotId, qty) {
  let left = Number(qty) || 0;
  if (left <= 0 || !lotRow || !targetOversoldLotId) return 0;
  const entries = parseSettlementLog_(lotRow['Settlement Log']);
  let trimmed = 0;
  for (let i = entries.length - 1; i >= 0 && left > 0; i--) {
    if (String(entries[i].lotId) !== String(targetOversoldLotId)) continue;
    const t = Math.min(entries[i].qty, left);
    entries[i].qty -= t;
    left -= t;
    trimmed += t;
  }
  if (trimmed > 0) {
    const formatted = formatSettlementLog_(entries);
    updateRowFields_('STOCK_LOTS', lotRow._rowIndex, { 'Settlement Log': formatted });
    lotRow['Settlement Log'] = formatted;
  }
  return trimmed;
}

/** Adds `qty` back into an inbound lot's Settlement Log (inverse of trimLotSettlementLog_). */
function addLotSettlementLog_(lotRow, targetOversoldLotId, qty, prevCost) {
  const addQty = Number(qty) || 0;
  if (addQty <= 0 || !lotRow || !targetOversoldLotId) return;
  const entries = parseSettlementLog_(lotRow['Settlement Log']);
  const existing = entries.filter(function (e) { return String(e.lotId) === String(targetOversoldLotId); });
  if (existing.length) {
    existing[existing.length - 1].qty += addQty;
  } else {
    entries.push({ lotId: String(targetOversoldLotId), qty: addQty, prevCost: Number(prevCost) || 0 });
  }
  const formatted = formatSettlementLog_(entries);
  updateRowFields_('STOCK_LOTS', lotRow._rowIndex, { 'Settlement Log': formatted });
  lotRow['Settlement Log'] = formatted;
}

/** Oversold debt this inbound lot has paid off (and not yet re-opened). */
function settledQuantityOfLot_(lotRow) {
  return parseSettlementLog_(lotRow && lotRow['Settlement Log']).reduce(function (a, e) { return a + e.qty; }, 0);
}

/**
 * Re-opens up to `qty` of the oversold debt this lot paid off, newest
 * settlement first: the oversold lot goes back below zero and it (and the
 * specific SALE_ITEM_LOTS slices this lot settled) return to the provisional
 * cost they had before. Used when a purchase (or return fallback lot) is
 * reduced or deleted. Returns the quantity re-opened.
 */
function reopenOversoldDebt_(lotRow, qty, allLots, saleItemLots) {
  let left = Number(qty) || 0, reopened = 0;
  if (left <= 0 || !lotRow) return 0;
  const entries = parseSettlementLog_(lotRow['Settlement Log']);
  if (!entries.length) return 0;
  const lots = allLots || getAllRows_('STOCK_LOTS');
  const sales = saleItemLots || getAllRows_('SALE_ITEM_LOTS');
  const settlingLotId = String(lotRow['Lot ID'] || '');

  for (let i = entries.length - 1; i >= 0 && left > 0; i--) {
    const e = entries[i];
    const target = lots.filter(function (l) { return l['Lot ID'] === e.lotId; })[0];
    if (!target) continue;
    const t = Math.min(e.qty, left);
    const after = (Number(target['Remaining Quantity']) || 0) - t;
    const fields = { 'Remaining Quantity': after, 'Status': after < 0 ? 'Oversold' : 'Settled' };
    if (e.prevCost > 0) fields['Purchase Price'] = e.prevCost;
    updateRowFields_('STOCK_LOTS', target._rowIndex, fields);
    target['Remaining Quantity'] = after;
    target['Status'] = fields['Status'];
    if (e.prevCost > 0) target['Purchase Price'] = e.prevCost;

    // Move back only the slices settled by THIS inbound lot for e.lotId.
    const settledSlices = sales.filter(function (row) {
      return String(row['Lot ID'] || '') === settlingLotId &&
        String(row['Settled From Lot ID'] || '') === String(e.lotId) &&
        (Number(row['Quantity']) || 0) > 0;
    }).sort(function (a, b) { return (b._rowIndex || 0) - (a._rowIndex || 0); });

    if (settledSlices.length) {
      let toRevert = t;
      for (let j = 0; j < settledSlices.length && toRevert > 0; j++) {
        const row = settledSlices[j];
        const rowQty = Number(row['Quantity']) || 0;
        const slice = Math.min(rowQty, toRevert);
        if (slice <= 0) continue;
        const revertCost = e.prevCost > 0 ? e.prevCost : (Number(row['Unit Cost']) || 0);
        if (Math.abs(slice - rowQty) < 1e-8) {
          updateRowFields_('SALE_ITEM_LOTS', row._rowIndex, {
            'Lot ID': e.lotId,
            'Unit Cost': revertCost,
            'Supplier ID': '',
            'Settled From Lot ID': ''
          });
          row['Lot ID'] = e.lotId;
          row['Unit Cost'] = revertCost;
          row['Supplier ID'] = '';
          row['Settled From Lot ID'] = '';
        } else {
          const keepQty = rowQty - slice;
          updateRowFields_('SALE_ITEM_LOTS', row._rowIndex, { 'Quantity': keepQty });
          row['Quantity'] = keepQty;
          const revertedRow = {
            'Invoice ID': row['Invoice ID'],
            'Product ID': row['Product ID'],
            'Lot ID': e.lotId,
            'Quantity': slice,
            'Unit Cost': revertCost,
            'Unit Sell Price': row['Unit Sell Price'],
            'Created At': row['Created At'] || new Date(),
            'Supplier ID': '',
            'Source Sale Product ID': row['Source Sale Product ID'] || row['Product ID'],
            'Return Consumption Link ID': '',
            'Settled From Lot ID': ''
          };
          const newIdx = appendRow_('SALE_ITEM_LOTS', revertedRow);
          revertedRow._rowIndex = newIdx;
          sales.push(revertedRow);
        }
        toRevert -= slice;
      }
    } else if (e.prevCost > 0) {
      // Legacy pre-split fallback
      recostSaleItemLots_(e.lotId, e.prevCost, sales);
    }

    e.qty -= t; left -= t; reopened += t;
  }
  updateRowFields_('STOCK_LOTS', lotRow._rowIndex, { 'Settlement Log': formatSettlementLog_(entries) });
  lotRow['Settlement Log'] = formatSettlementLog_(entries);
  return reopened;
}

/** A purchase's unit price was corrected: the oversold slices it settled take the new price. */
function recostSettledOversoldLots_(lotRow, newPrice, allLots, saleItemLots) {
  const cost = Number(newPrice) || 0;
  if (cost <= 0 || !lotRow) return;
  const lots = allLots || getAllRows_('STOCK_LOTS');
  const sales = saleItemLots || getAllRows_('SALE_ITEM_LOTS');
  const settlingLotId = String(lotRow['Lot ID'] || '');

  parseSettlementLog_(lotRow['Settlement Log']).forEach(function (e) {
    const settledSlices = sales.filter(function (row) {
      return String(row['Lot ID'] || '') === settlingLotId &&
        String(row['Settled From Lot ID'] || '') === String(e.lotId);
    });
    if (settledSlices.length) {
      settledSlices.forEach(function (row) {
        if (Math.abs((Number(row['Unit Cost']) || 0) - cost) < 0.0000001) return;
        updateRowFields_('SALE_ITEM_LOTS', row._rowIndex, { 'Unit Cost': cost });
        row['Unit Cost'] = cost;
      });
    } else {
      // Legacy pre-split fallback
      const target = lots.filter(function (l) { return l['Lot ID'] === e.lotId; })[0];
      if (target) {
        updateRowFields_('STOCK_LOTS', target._rowIndex, { 'Purchase Price': cost });
        target['Purchase Price'] = cost;
      }
      recostSaleItemLots_(e.lotId, cost, sales);
    }
  });
}

/**
 * Creates a lot for stock that physically comes IN (purchase, adjustment,
 * return). The lot keeps its full Original Quantity so purchase edit/return/
 * delete keep finding it by Purchase ID, but any quantity that pays off
 * oversold debt is taken out of its Remaining Quantity at once - so negative
 * and positive lots never sit side by side.
 * Returns { id, rowIndex, absorbed, settledLotIds }.
 */
function createInboundLot_(productId, productName, purchaseId, purchaseDate, purchasePrice, qty, supplierId, supplierName, sellPrice, allLots) {
  const lot = createLotWithRow_(productId, productName, purchaseId, purchaseDate, purchasePrice, qty, supplierId, supplierName, sellPrice);
  const settled = settleOversoldLots_(productId, qty, purchasePrice, allLots, null, {
    id: lot.id,
    supplierId: supplierId || ''
  });
  if (settled.absorbed > 0) {
    const left = (Number(qty) || 0) - settled.absorbed;
    updateRowFields_('STOCK_LOTS', lot.rowIndex, {
      'Remaining Quantity': left, 'Status': left > 0 ? 'Active' : 'Consumed',
      'Settlement Log': formatSettlementLog_(settled.entries)
    });
  }
  return { id: lot.id, rowIndex: lot.rowIndex, absorbed: settled.absorbed, settledLotIds: settled.lotIds };
}

/**
 * Writes a plan from planStockConsumption_. Returns the same
 * [{ lotId, qty, unitCost }] shape consumeStockFIFO_ has always returned,
 * so callers that build Stock Movement rows from it need no changes.
 */
function applyStockConsumption_(plan, txDate) {
  const consumption = [];
  const lotDate = txDate || new Date();

  plan.draws.forEach(function (d) {
    updateRowFields_('STOCK_LOTS', d.rowIndex, {
      'Remaining Quantity': d.remainingAfter,
      'Status': d.remainingAfter > 0 ? 'Active' : 'Consumed'
    });
    consumption.push({ lotId: d.lotId, qty: d.take, unitCost: d.unitCost, unitSellPrice: d.unitSellPrice });
  });

  if (plan.shortfall > 0) {
    // Keep the shortfall as a negative remaining quantity. This makes the
    // lot ledger reconcile with Products.Current Stock even when stock is
    // negative, while FIFO ignores the negative lot until a real purchase
    // arrives. The lot is bookkeeping only; no physical stock was consumed.
    const lot = createLotWithRow_(plan.productId, plan.fallbackName, 'OVERSOLD', lotDate, plan.fallbackPrice, plan.shortfall, '', '', plan.fallbackSellPrice);
    updateRowFields_('STOCK_LOTS', lot.rowIndex, {
      'Remaining Quantity': -plan.shortfall,
      'Status': 'Oversold'
    });
    consumption.push({ lotId: lot.id, qty: plan.shortfall, unitCost: plan.fallbackPrice, unitSellPrice: plan.fallbackSellPrice });
  }
  return consumption;
}

/**
 * Restores `qty` units of productId back onto the lots a specific sale
 * (invoiceId) actually drew from — walking its recorded SALE_ITEM_LOTS
 * rows most-recently-consumed-first (LIFO), so a return unwinds a sale
 * the same way it happened. Each SALE_ITEM_LOTS row's own Quantity is
 * decremented as it's used up, so repeated partial returns on the same
 * invoice/product never restore more than was actually sold from a lot.
 * Falls back to a fresh lot (tagged with fallbackReference) for any
 * leftover the recorded consumption can't cover, so a return never
 * silently fails to give stock back.
 *
 * supplierId is optional but should always be passed once the caller knows
 * it: an invoice can have two SALE_ITEMS lines for the same product from
 * different suppliers (or one real supplier and one unattributed — see
 * planStockConsumption_), so Invoice ID + Product ID alone can no longer
 * tell their consumption rows apart. Pass '' to restore only the
 * unattributed line's own consumption; omitting supplierId entirely
 * restores across every line (only safe for callers that predate
 * multi-supplier lines).
 *
 * Returns [{ lotId, qty }, ...] restored, for the caller's Stock Movement rows.
 */
/**
 * Read-only Sales Return restoration planner. It reserves SALE_ITEM_LOTS
 * evidence and STOCK_LOTS remaining quantities in an optional shared virtual
 * state so several child returns can be fully planned before any Sheet write.
 */
function planSaleReturnRestoration_(invoiceId, productId, productName, qty, options) {
  const opts = options || {};
  let need = Number(qty) || 0;
  const plan = {
    invoiceId: invoiceId,
    productId: productId,
    productName: productName,
    qty: need,
    draws: [],
    fallbackQty: 0
  };
  if (need <= 0) return plan;

  const supplierId = opts.supplierId;
  const scoped = supplierId !== undefined && supplierId !== null;
  const sourceSaleProductId = opts.sourceSaleProductId;
  const scopedSource = sourceSaleProductId !== undefined && sourceSaleProductId !== null;
  const saleItemLots = opts.saleItemLots || getAllRows_('SALE_ITEM_LOTS');
  const stockLots = opts.stockLots || getAllRows_('STOCK_LOTS');
  const products = opts.products || getAllRows_('PRODUCTS');
  const virtualState = opts.virtualState || {};
  const saleQtyByRow = virtualState.saleItemLotQtyByRowIndex || (virtualState.saleItemLotQtyByRowIndex = {});
  const lotRemainingByRow = virtualState.lotRemainingByRowIndex || (virtualState.lotRemainingByRowIndex = {});

  const consumedRows = saleItemLots
    .filter(function (r) {
      return r['Invoice ID'] === invoiceId && r['Product ID'] === productId &&
        (!scoped || r['Supplier ID'] === supplierId) &&
        (!scopedSource || String(r['Source Sale Product ID'] || r['Product ID']) === String(sourceSaleProductId));
    })
    .sort(function (a, b) { return b._rowIndex - a._rowIndex; });

  const lotsById = opts.lotsById || {};
  if (!opts.lotsById) {
    stockLots.forEach(function (lot) { lotsById[lot['Lot ID']] = lot; });
  }
  const product = products.filter(function (p) { return p['Product ID'] === productId; })[0];
  const productPrice = product ? Number(product['Purchase Price']) || 0 : 0;
  // A returned unit goes back at what the sale actually cost it; the
  // product's own Purchase Price is only the last resort.
  const rowCost = function (row) {
    const c = Number(row['Unit Cost']) || 0;
    return c > 0 ? c : productPrice;
  };
  const productLotsForCheck = stockLots.filter(function (l) {
    return l['Product ID'] === productId && String(l['Status'] || '').toLowerCase() !== 'deleted';
  });
  const hasActiveOversoldDebt = function () {
    return productLotsForCheck.some(function (l) {
      const rem = Object.prototype.hasOwnProperty.call(lotRemainingByRow, l._rowIndex)
        ? Number(lotRemainingByRow[l._rowIndex]) || 0
        : Number(l['Remaining Quantity']) || 0;
      return rem < 0;
    });
  };

  for (let i = 0; i < consumedRows.length && need > 0; i++) {
    const row = consumedRows[i];
    if (!Object.prototype.hasOwnProperty.call(saleQtyByRow, row._rowIndex)) {
      saleQtyByRow[row._rowIndex] = Math.max(0, Number(row['Quantity']) || 0);
    }
    const outstanding = Number(saleQtyByRow[row._rowIndex]) || 0;
    const give = Math.min(outstanding, need);
    if (give <= 0) continue;

    const lot = lotsById[row['Lot ID']];
    const saleItemLotQtyAfter = outstanding - give;
    saleQtyByRow[row._rowIndex] = saleItemLotQtyAfter;

    const isOversoldLot = !!lot && String(lot['Purchase ID'] || '').toUpperCase() === 'OVERSOLD';
    let lotQty = 0;
    // If an unrelated active OVERSOLD lot exists on this product, route the
    // return through createInboundLot_ (FALLBACK) so returned stock settles
    // the oversold debt first instead of creating coexisting positive + negative lots.
    const deferToOversoldSettlement = !isOversoldLot && hasActiveOversoldDebt();
    if (lot && lot['Purchase ID'] !== 'LEGACY' && !deferToOversoldSettlement) {
      if (!Object.prototype.hasOwnProperty.call(lotRemainingByRow, lot._rowIndex)) {
        lotRemainingByRow[lot._rowIndex] = Number(lot['Remaining Quantity']) || 0;
      }
      const lotRemainingBefore = Number(lotRemainingByRow[lot._rowIndex]) || 0;
      // An oversold lot is only repaid up to what it still owes; once it is
      // settled (remaining 0) the returned units become a real lot instead.
      lotQty = isOversoldLot ? Math.max(0, Math.min(give, -lotRemainingBefore)) : give;
      if (lotQty > 0) {
        const lotRemainingAfter = lotRemainingBefore + lotQty;
        lotRemainingByRow[lot._rowIndex] = lotRemainingAfter;
        plan.draws.push({
          sourceKind: 'LOT',
          saleItemLotRowIndex: row._rowIndex,
          saleItemLotQtyAfter: outstanding - lotQty,
          lotRowIndex: lot._rowIndex,
          lotRemainingAfter: lotRemainingAfter,
          lotIsOversold: isOversoldLot,
          settledFromLotId: String(row['Settled From Lot ID'] || ''),
          lotId: row['Lot ID'],
          qty: lotQty,
          consumptionLinkId: row['Return Consumption Link ID'] || '',
          supplierId: row['Supplier ID'] || ''
        });
      }
    }
    const spill = give - lotQty;
    if (spill > 0) {
      plan.draws.push({
        sourceKind: 'FALLBACK',
        saleItemLotRowIndex: row._rowIndex,
        saleItemLotQtyAfter: saleItemLotQtyAfter,
        lotId: row['Lot ID'] || '',
        qty: spill,
        consumptionLinkId: row['Return Consumption Link ID'] || '',
        purchasePrice: rowCost(row),
        supplierId: row['Supplier ID'] || ''
      });
      plan.fallbackQty += spill;
    }
    need -= give;
  }

  if (need > 0) {
    plan.draws.push({
      sourceKind: 'FALLBACK',
      saleItemLotRowIndex: null,
      saleItemLotQtyAfter: null,
      lotId: '',
      qty: need,
      purchasePrice: productPrice,
      supplierId: scoped ? supplierId : ''
    });
    plan.fallbackQty += need;
  }
  return plan;
}

/** Apply a previously prepared Sales Return restoration plan. */
function applySaleReturnRestorationPlan_(plan, fallbackReference) {
  const restored = [];
  const linkByRow = {};
  (plan && plan.draws || []).forEach(function (draw) {
    let lotId = draw.lotId;
    if (draw.sourceKind === 'LOT') {
      const nextStatus = draw.lotRemainingAfter < 0 ? 'Oversold'
        : (draw.lotRemainingAfter === 0 && draw.lotIsOversold ? 'Settled' : 'Active');
      updateRowFields_('STOCK_LOTS', draw.lotRowIndex, {
        'Remaining Quantity': draw.lotRemainingAfter,
        'Status': nextStatus
      });
      if (draw.settledFromLotId) {
        const lotRow = getAllRows_('STOCK_LOTS').filter(function (l) { return l._rowIndex === draw.lotRowIndex; })[0];
        if (lotRow) trimLotSettlementLog_(lotRow, draw.settledFromLotId, draw.qty);
      }
    } else {
      // Returned stock pays off any other oversold debt before it becomes
      // sellable, exactly like a purchase does.
      lotId = createInboundLot_(
        plan.productId,
        plan.productName,
        fallbackReference || 'RETURN',
        new Date(),
        Number(draw.purchasePrice) || 0,
        draw.qty,
        draw.supplierId || '',
        ''
      ).id;
    }
    let sourceConsumptionLinkId = draw.consumptionLinkId || '';
    if (draw.saleItemLotRowIndex) {
      if (!sourceConsumptionLinkId) sourceConsumptionLinkId = linkByRow[draw.saleItemLotRowIndex] || generateId_('STOCK_MOVEMENT');
      linkByRow[draw.saleItemLotRowIndex] = sourceConsumptionLinkId;
      updateRowFields_('SALE_ITEM_LOTS', draw.saleItemLotRowIndex, {
        'Quantity': draw.saleItemLotQtyAfter,
        'Return Consumption Link ID': sourceConsumptionLinkId
      });
    }
    restored.push({ lotId: lotId, qty: draw.qty, sourceConsumptionLinkId: sourceConsumptionLinkId });
  });
  return restored;
}

/** Compatibility wrapper for existing single-return callers. */
function restoreStockToLots_(invoiceId, productId, productName, qty, fallbackReference, supplierId, sourceSaleProductId) {
  return applySaleReturnRestorationPlan_(
    planSaleReturnRestoration_(invoiceId, productId, productName, qty, {
      supplierId: supplierId, sourceSaleProductId: sourceSaleProductId
    }),
    fallbackReference
  );
}

/**
 * Reduces the lot a specific purchase line created (Purchase Return —
 * goods physically leaving to go back to the supplier). Falls back to
 * FIFO across whatever lots exist if the purchase predates the lot
 * system (no matching lot row on file), so old purchases can still be
 * returned. Returns [{ lotId, qty }, ...] for the caller's Stock Movement rows.
 */
function reduceLotForPurchaseReturn_(purchaseId, productId, qty) {
  return applyPurchaseReturnLotReduction_(
    planPurchaseReturnLotReduction_(purchaseId, productId, qty)
  );
}

/**
 * Read-only Purchase Return planner.  A purchase can have more than one lot
 * for a product in historical data, so every matching lot is considered in
 * FIFO order.  If the purchase predates the lot system and has no matching
 * lot at all, preserve the old legacy fallback by planning FIFO across the
 * product's available lots — but never allow a shortfall/OVERSOLD write from a
 * Purchase Return.
 */
function planPurchaseReturnLotReduction_(purchaseId, productId, qty, allLots) {
  let need = Number(qty) || 0;
  const plan = { purchaseId: purchaseId, productId: productId, draws: [], legacyFallback: false };
  if (need <= 0) return plan;

  const lots = allLots || getAllRows_('STOCK_LOTS');
  const purchaseLotsAll = lots.filter(function (l) {
    return l['Purchase ID'] === purchaseId && l['Product ID'] === productId &&
      String(l['Status'] || '').toLowerCase() !== 'deleted';
  });

  if (purchaseLotsAll.length) {
    const availableLots = purchaseLotsAll
      .filter(function (l) { return (Number(l['Remaining Quantity']) || 0) > 0; })
      .sort(compareLotsFifo_);

    for (let i = 0; i < availableLots.length && need > 0; i++) {
      const lot = availableLots[i];
      const available = Number(lot['Remaining Quantity']) || 0;
      const take = Math.min(available, need);
      if (take <= 0) continue;
      plan.draws.push({
        lotId: lot['Lot ID'], rowIndex: lot._rowIndex, take: take,
        unitCost: Number(lot['Purchase Price']) || 0,
        remainingAfter: available - take
      });
      need -= take;
    }

    if (need > 0) {
      const remaining = plan.draws.reduce(function (sum, d) { return sum + d.take; }, 0);
      throw new Error('Lots for this purchase only have ' + remaining + ' remaining \u2014 cannot return ' + qty + '.');
    }
    return plan;
  }

  const legacyPlan = planStockConsumption_(productId, need, lots);
  if (legacyPlan.shortfall > 0) {
    const available = need - legacyPlan.shortfall;
    throw new Error('Only ' + available + ' units are available in stock lots \u2014 cannot return ' + need + '.');
  }
  plan.legacyFallback = true;
  plan.draws = legacyPlan.draws;
  return plan;
}

/** Applies a previously validated Purchase Return lot plan. */
function applyPurchaseReturnLotReduction_(plan) {
  const reduced = [];
  (plan && plan.draws ? plan.draws : []).forEach(function (d) {
    updateRowFields_('STOCK_LOTS', d.rowIndex, {
      'Remaining Quantity': d.remainingAfter,
      'Status': d.remainingAfter > 0 ? 'Active' : 'Consumed'
    });
    reduced.push({ lotId: d.lotId, qty: d.take, unitCost: d.unitCost });
  });
  return reduced;
}

/** True when a lot source is internal/non-purchase stock eligible for cost repair. */
function isInternalCostCorrectionSource_(purchaseId) {
  const source = String(purchaseId || '').trim().toUpperCase();
  return source === 'OPENING' ||
    source === 'OPENING-MIGRATION' ||
    source === 'ADJUSTMENT' ||
    source === 'LEGACY' ||
    source.indexOf('OPENING-') === 0 ||
    source.indexOf('ADJUSTMENT-') === 0;
}

/** Prevents positive internal stock from ever being created without a real cost. */
function assertPositiveInternalLotCost_(purchaseId, qty, purchasePrice) {
  if (!isInternalCostCorrectionSource_(purchaseId)) return;
  if ((Number(qty) || 0) <= 0) return;
  if (!isValidNonNegativeNumber_(purchasePrice) || Number(purchasePrice) <= 0) {
    throw new Error("Set this product's Purchase Price before adding stock.");
  }
}

/** Blank/null or numeric zero means the internal lot has no stored cost. */
function isZeroStoredCost_(rawCost) {
  if (rawCost === '' || rawCost === null || rawCost === undefined) return true;
  if (typeof rawCost === 'string' && rawCost.trim() === '') return true;
  const value = Number(rawCost);
  return Number.isFinite(value) && value === 0;
}

function buildInternalStockLotCostCandidate_(lot, product, saleItemLots) {
  const lotId = String(lot && lot['Lot ID'] || '');
  const suggestedCost = product && Number(product['Purchase Price']) > 0
    ? Number(product['Purchase Price'])
    : 0;
  const matches = (saleItemLots || []).filter(function (row) {
    return String(row['Lot ID'] || '') === lotId;
  });
  const invoices = {};
  let matchedHistoricalQuantity = 0;
  let historicalCurrentCogs = 0;
  let historicalCogsDelta = 0;
  matches.forEach(function (row) {
    const qty = Number(row['Quantity']) || 0;
    const oldCost = Number(row['Unit Cost']) || 0;
    matchedHistoricalQuantity += qty;
    historicalCurrentCogs += qty * oldCost;
    historicalCogsDelta += qty * (suggestedCost - oldCost);
    const invoiceId = String(row['Invoice ID'] || '');
    if (invoiceId) invoices[invoiceId] = true;
  });
  const originalQuantity = Number(lot && lot['Original Quantity']) || 0;
  const remainingQuantity = Number(lot && lot['Remaining Quantity']) || 0;
  return {
    lotId: lotId,
    productId: String(lot && lot['Product ID'] || ''),
    productName: String(lot && lot['Product Name'] || (product && product['Product Name']) || ''),
    source: String(lot && lot['Purchase ID'] || ''),
    purchaseDate: safeDateOnly_(lot && lot['Purchase Date']),
    originalQuantity: originalQuantity,
    remainingQuantity: remainingQuantity,
    consumedQuantity: Math.max(0, originalQuantity - remainingQuantity),
    currentPurchasePrice: Number(lot && lot['Purchase Price']) || 0,
    productPurchasePrice: product ? (Number(product['Purchase Price']) || 0) : 0,
    suggestedPurchasePrice: suggestedCost,
    matchedHistoricalQuantity: matchedHistoricalQuantity,
    affectedInvoiceCount: Object.keys(invoices).length,
    historicalCurrentCogs: roundMoney_(historicalCurrentCogs),
    historicalCogsDelta: roundMoney_(historicalCogsDelta),
    status: suggestedCost > 0 ? 'Ready' : 'Needs Cost'
  };
}

/** Loads all data needed for a cost correction once, then indexes it. */
function loadInternalStockLotCostCorrectionContext_() {
  const products = getAllRows_('PRODUCTS');
  const lots = getAllRows_('STOCK_LOTS');
  const saleItemLots = getAllRows_('SALE_ITEM_LOTS');
  const productsById = {};
  const lotsById = {};
  const evidenceByLotId = {};

  products.forEach(function (p) {
    const productId = String(p['Product ID'] || '');
    if (productId) productsById[productId] = p;
  });
  lots.forEach(function (lot) {
    const lotId = String(lot['Lot ID'] || '');
    if (!lotId) return;
    if (!lotsById[lotId]) lotsById[lotId] = [];
    lotsById[lotId].push(lot);
  });
  saleItemLots.forEach(function (row) {
    const lotId = String(row['Lot ID'] || '');
    if (!lotId) return;
    if (!evidenceByLotId[lotId]) evidenceByLotId[lotId] = [];
    evidenceByLotId[lotId].push(row);
  });

  return {
    productsById: productsById,
    lotsById: lotsById,
    evidenceByLotId: evidenceByLotId
  };
}

/**
 * Validates an entire requested correction batch without writing anything.
 * Exact Lot ID is the only historical linkage accepted.
 */
function prepareInternalStockLotCostCorrections_(payload, context) {
  payload = payload || {};
  context = context || {};
  const reason = sanitizeInput_(payload.reason);
  if (!reason) throw new Error('Enter a reason for this stock lot cost correction.');

  const corrections = Array.isArray(payload.corrections) ? payload.corrections : [];
  if (!corrections.length) throw new Error('Select at least one stock lot to correct.');

  const seen = {};
  const prepared = corrections.map(function (correction, index) {
    correction = correction || {};
    const lotId = sanitizeInput_(correction.lotId);
    if (!lotId) throw new Error('Correction ' + (index + 1) + ': Lot ID is required.');
    if (seen[lotId]) throw new Error('Duplicate Lot ID in correction request: ' + lotId + '.');
    seen[lotId] = true;

    const lotRows = (context.lotsById && context.lotsById[lotId]) || [];
    if (!lotRows.length) throw new Error('Stock lot not found: ' + lotId + '.');
    if (lotRows.length !== 1) throw new Error('Stock lot ID is not unique: ' + lotId + '.');
    const lot = lotRows[0];
    if (String(lot['Status'] || '').trim().toLowerCase() === 'deleted') {
      throw new Error('Stock lot ' + lotId + ' has been deleted.');
    }
    if (!isInternalCostCorrectionSource_(lot['Purchase ID'])) {
      throw new Error('Only internal Opening/Adjustment/Legacy lots can be corrected here. Use Purchase Edit for purchase-origin lots.');
    }
    if (!isZeroStoredCost_(lot['Purchase Price'])) {
      throw new Error('Stock lot ' + lotId + ' already has a Purchase Price; this correction only repairs blank/zero-cost internal lots.');
    }

    const newPurchasePrice = Number(correction.newPurchasePrice);
    if (!isValidNonNegativeNumber_(correction.newPurchasePrice) || newPurchasePrice <= 0) {
      throw new Error('Correction ' + lotId + ': Purchase Price must be a valid number greater than zero.');
    }

    const productId = String(lot['Product ID'] || '');
    const product = context.productsById && context.productsById[productId];
    if (!product) throw new Error('Product not found for stock lot ' + lotId + '.');

    const sourceRows = (context.evidenceByLotId && context.evidenceByLotId[lotId]) || [];
    const matchedRows = [];
    const invoices = {};
    let matchedHistoricalQuantity = 0;
    let historicalCogsDelta = 0;
    sourceRows.forEach(function (row) {
      if (String(row['Lot ID'] || '') !== lotId) return;
      const qty = Number(row['Quantity']) || 0;
      const oldUnitCost = Number(row['Unit Cost']) || 0;
      matchedHistoricalQuantity += qty;
      historicalCogsDelta += qty * (newPurchasePrice - oldUnitCost);
      const invoiceId = String(row['Invoice ID'] || '');
      if (invoiceId) invoices[invoiceId] = true;
      matchedRows.push({
        rowIndex: row._rowIndex,
        invoiceId: invoiceId,
        quantity: qty,
        oldUnitCost: oldUnitCost
      });
    });

    return {
      lot: lot,
      lotRowIndex: lot._rowIndex,
      product: product,
      newPurchasePrice: newPurchasePrice,
      matchedRows: matchedRows,
      matchedHistoricalQuantity: matchedHistoricalQuantity,
      affectedInvoiceCount: Object.keys(invoices).length,
      historicalCogsDelta: roundMoney_(historicalCogsDelta)
    };
  });

  return prepared;
}

/** Applies a fully validated correction batch. No business validation lives here. */
function commitInternalStockLotCostCorrections_(user, reason, prepared) {
  const now = new Date();
  const items = (prepared || []).slice().sort(function (a, b) {
    return String(a.lot['Lot ID']).localeCompare(String(b.lot['Lot ID']));
  });
  const result = {
    correctedCount: 0,
    matchedHistoricalQuantity: 0,
    affectedInvoiceCount: 0,
    historicalCogsDelta: 0,
    lots: []
  };
  const affectedInvoices = {};

  items.forEach(function (item) {
    updateRowFields_('STOCK_LOTS', item.lotRowIndex, {
      'Purchase Price': item.newPurchasePrice
    });
    item.matchedRows.forEach(function (row) {
      updateRowFields_('SALE_ITEM_LOTS', row.rowIndex, {
        'Unit Cost': item.newPurchasePrice
      });
      if (row.invoiceId) affectedInvoices[row.invoiceId] = true;
    });
    appendRow_('STOCK_LOT_COST_CORRECTIONS', {
      'Correction ID': generateId_('STOCK_LOT_COST_CORRECTIONS'),
      'Date': now,
      'Lot ID': item.lot['Lot ID'],
      'Product ID': item.product['Product ID'],
      'Product Name': item.product['Product Name'],
      'Source': item.lot['Purchase ID'],
      'Old Purchase Price': Number(item.lot['Purchase Price']) || 0,
      'New Purchase Price': item.newPurchasePrice,
      'Original Quantity': Number(item.lot['Original Quantity']) || 0,
      'Remaining Quantity': Number(item.lot['Remaining Quantity']) || 0,
      'Matched Historical Quantity': item.matchedHistoricalQuantity,
      'Affected Invoice Count': item.affectedInvoiceCount,
      'Historical COGS Delta': item.historicalCogsDelta,
      'Reason': reason,
      'Corrected By': actorName_(user),
      'Created At': now
    });

    result.correctedCount++;
    result.matchedHistoricalQuantity += item.matchedHistoricalQuantity;
    result.historicalCogsDelta += item.historicalCogsDelta;
    result.lots.push({
      lotId: item.lot['Lot ID'],
      newPurchasePrice: item.newPurchasePrice,
      matchedHistoricalQuantity: item.matchedHistoricalQuantity,
      affectedInvoiceCount: item.affectedInvoiceCount,
      historicalCogsDelta: item.historicalCogsDelta
    });
  });

  result.affectedInvoiceCount = Object.keys(affectedInvoices).length;
  result.historicalCogsDelta = roundMoney_(result.historicalCogsDelta);
  return result;
}

/** Corrects one or more zero-cost internal stock lots after full batch validation. */
function correctInternalStockLotCosts(token, payload) {
  const lock = LockService.getScriptLock();
  lock.waitLock(CONFIG.LOCK_TIMEOUT_MS);
  try {
    const user = requirePermission_(token, 'products', 'edit');
    const context = loadInternalStockLotCostCorrectionContext_();
    const prepared = prepareInternalStockLotCostCorrections_(payload, context);
    const reason = sanitizeInput_(payload && payload.reason);
    return ok_(commitInternalStockLotCostCorrections_(user, reason, prepared));
  } catch (err) {
    logError_('correctInternalStockLotCosts', err);
    return fail_(err.message);
  } finally {
    lock.releaseLock();
  }
}

/** Thin single-lot wrapper over the validated batch correction engine. */
function correctInternalStockLotCost(token, payload) {
  payload = payload || {};
  return correctInternalStockLotCosts(token, {
    corrections: [{
      lotId: payload.lotId,
      newPurchasePrice: payload.newPurchasePrice
    }],
    reason: payload.reason
  });
}

/**
 * Adds a brand-new lot for a positive manual stock adjustment, at the
 * product's current Purchase Price. supplierId/supplierName are optional —
 * pass them when the correction is known to belong to one already-linked
 * supplier (attributes the added stock so it's sellable through that
 * supplier in POS); omit for a genuinely unattributed correction (the
 * stock still counts toward Products.Current Stock, it just isn't scoped
 * to any supplier until adjusted again with one).
 */
function addAdjustmentLot_(productId, productName, qty, supplierId, supplierName) {
  const product = getAllRows_('PRODUCTS').filter(function (p) { return p['Product ID'] === productId; })[0];
  const price = product ? Number(product['Purchase Price']) || 0 : 0;
  const sellPrice = product ? Number(product['Selling Price']) || 0 : 0;
  return createInboundLot_(productId, productName, 'ADJUSTMENT', new Date(), price, qty, supplierId, supplierName, sellPrice).id;
}

/** Lists zero/blank-cost internal lots with exact historical COGS impact previews. */
function getUnpricedInternalStockLots(token) {
  try {
    requirePermission_(token, 'products', 'view');
    const products = getAllRows_('PRODUCTS');
    const lots = getAllRows_('STOCK_LOTS');
    const saleItemLots = getAllRows_('SALE_ITEM_LOTS');

    const productsById = {};
    products.forEach(function (p) { productsById[p['Product ID']] = p; });

    const evidenceByLotId = {};
    saleItemLots.forEach(function (row) {
      const lotId = String(row['Lot ID'] || '');
      if (!lotId) return;
      if (!evidenceByLotId[lotId]) evidenceByLotId[lotId] = [];
      evidenceByLotId[lotId].push(row);
    });

    const candidates = lots.filter(function (lot) {
      return String(lot['Status'] || '').toLowerCase() !== 'deleted' &&
        isInternalCostCorrectionSource_(lot['Purchase ID']) &&
        isZeroStoredCost_(lot['Purchase Price']);
    }).map(function (lot) {
      return buildInternalStockLotCostCandidate_(
        lot,
        productsById[lot['Product ID']] || null,
        evidenceByLotId[String(lot['Lot ID'] || '')] || []
      );
    }).sort(function (a, b) {
      return String(a.lotId).localeCompare(String(b.lotId));
    });

    const summary = candidates.reduce(function (out, c) {
      out.candidateCount++;
      if (c.status === 'Ready') out.readyCount++;
      else out.needsCostCount++;
      out.remainingQuantity += Number(c.remainingQuantity) || 0;
      out.matchedHistoricalQuantity += Number(c.matchedHistoricalQuantity) || 0;
      out.projectedHistoricalCogsDelta += Number(c.historicalCogsDelta) || 0;
      return out;
    }, {
      candidateCount: 0,
      readyCount: 0,
      needsCostCount: 0,
      remainingQuantity: 0,
      matchedHistoricalQuantity: 0,
      projectedHistoricalCogsDelta: 0
    });
    summary.projectedHistoricalCogsDelta = roundMoney_(summary.projectedHistoricalCogsDelta);

    return ok_({ lots: candidates, summary: summary });
  } catch (err) {
    logError_('getUnpricedInternalStockLots', err);
    return fail_(err.message);
  }
}

/** Every lot for one product, oldest first — powers the Products page "Lots" drill-down. */
function getProductLots(token, productId) {
  try {
    requirePermission_(token, 'products', 'view');
    const id = sanitizeInput_(productId);
    if (!id) return fail_('Product ID is required.');
    const productRow = getAllRows_('PRODUCTS').filter(function (p) { return p['Product ID'] === id; })[0];
    const lots = getAllRows_('STOCK_LOTS')
      .filter(function (l) { return l['Product ID'] === id; })
      .sort(compareLotsFifo_);
    const evidenceByLotId = {};
    getAllRows_('SALE_ITEM_LOTS').forEach(function (row) {
      const lotId = String(row['Lot ID'] || '');
      if (!lotId) return;
      if (!evidenceByLotId[lotId]) evidenceByLotId[lotId] = [];
      evidenceByLotId[lotId].push(row);
    });

    // Explicit shape rather than the raw row: _rowIndex is an internal
    // bookkeeping field and has no business crossing to the browser.
    return ok_(lots.map(function (l) {
      const status = l['Status'] || 'Active';
      const eligible = String(status).toLowerCase() !== 'deleted' &&
        isInternalCostCorrectionSource_(l['Purchase ID']) &&
        isZeroStoredCost_(l['Purchase Price']);
      const candidate = eligible
        ? buildInternalStockLotCostCandidate_(l, productRow || null, evidenceByLotId[String(l['Lot ID'] || '')] || [])
        : null;
      return {
        lotId: l['Lot ID'],
        productId: l['Product ID'],
        productName: l['Product Name'],
        purchaseId: l['Purchase ID'],
        purchaseDate: safeDateOnly_(l['Purchase Date']),
        supplierId: l['Supplier ID'] || '',
        supplierName: l['Supplier Name'] || '',
        purchasePrice: Number(l['Purchase Price']) || 0,
        sellPrice: lotSellPrice_(l, productRow),
        originalQuantity: Number(l['Original Quantity']) || 0,
        remainingQuantity: Number(l['Remaining Quantity']) || 0,
        status: status,
        createdAt: l['Created At'],
        costCorrectionEligible: eligible,
        productPurchasePrice: productRow ? (Number(productRow['Purchase Price']) || 0) : 0,
        suggestedPurchasePrice: candidate ? candidate.suggestedPurchasePrice : 0,
        matchedHistoricalQuantity: candidate ? candidate.matchedHistoricalQuantity : 0,
        affectedInvoiceCount: candidate ? candidate.affectedInvoiceCount : 0,
        historicalCurrentCogs: candidate ? candidate.historicalCurrentCogs : 0,
        historicalCogsDelta: candidate ? candidate.historicalCogsDelta : 0
      };
    }));
  } catch (err) {
    logError_('getProductLots', err);
    return fail_(err.message);
  }
}

/**
 * One-time (safe to re-run) migration: gives every product that has no
 * lot on file yet a single "Opening Lot" matching its current Current
 * Stock / Purchase Price, so FIFO has clean data to draw from instead of
 * relying on consumeStockFIFO_'s ad-hoc LEGACY fallback later. Products
 * that already have at least one lot are left untouched.
 */

/**
 * Idempotent additive migration for installs that already have Stock Lots.
 * Only blank Sell Price cells are filled; any explicitly-entered lot price,
 * including zero, is preserved exactly.
 */
function migrateStockLotSellPrices_() {
  const productsById = {};
  getAllRows_('PRODUCTS').forEach(function (p) { productsById[p['Product ID']] = p; });
  let updated = 0;
  getAllRows_('STOCK_LOTS').forEach(function (lot) {
    const raw = lot['Sell Price'];
    if (raw !== '' && raw !== null && raw !== undefined && String(raw).trim() !== '') return;
    const product = productsById[lot['Product ID']];
    const sellPrice = product && isValidNonNegativeNumber_(product['Selling Price']) ? Number(product['Selling Price']) : 0;
    updateRowFields_('STOCK_LOTS', lot._rowIndex, { 'Sell Price': sellPrice });
    updated++;
  });
  return { updated: updated };
}

/**
 * Rebuilds Products.Current Stock from the lot ledger.
 * Only products that already have at least one lot are changed, so products
 * without migrated lot history are left untouched.
 */
function reconcileProductStocksFromLots_() {
  const lock = LockService.getScriptLock();
  lock.waitLock(CONFIG.LOCK_TIMEOUT_MS);
  try {
    const lots = getAllRows_('STOCK_LOTS');
    const totals = {};
    lots.forEach(function (l) {
      if (String(l['Status'] || '').toLowerCase() === 'deleted') return;
      totals[l['Product ID']] = (totals[l['Product ID']] || 0) + (Number(l['Remaining Quantity']) || 0);
    });

    const products = getAllRows_('PRODUCTS');
    let updated = 0;
    products.forEach(function (p) {
      if (totals[p['Product ID']] === undefined) return;
      const value = totals[p['Product ID']];
      if ((Number(p['Current Stock']) || 0) !== value) {
        updateRowFields_('PRODUCTS', p._rowIndex, {
          'Current Stock': value,
          'Updated At': new Date()
        });
        updated++;
      }
    });
    SpreadsheetApp.flush();
    return ok_({ updated: updated });
  } catch (err) {
    logError_('reconcileProductStocksFromLots', err);
    return fail_(err.message);
  } finally {
    lock.releaseLock();
  }
}

function migrateOpeningStockLots_() {
  const ui = SpreadsheetApp.getUi();
  const lock = LockService.getScriptLock();
  lock.waitLock(CONFIG.LOCK_TIMEOUT_MS);
  try {
    const products = getAllRows_('PRODUCTS');
    const existingLotProductIds = {};
    getAllRows_('STOCK_LOTS').forEach(function (l) { existingLotProductIds[l['Product ID']] = true; });

    let created = 0;
    let unresolved = 0;
    products.forEach(function (p) {
      if (existingLotProductIds[p['Product ID']]) return;
      const stock = Number(p['Current Stock']) || 0;
      if (stock <= 0) return;
      const purchasePrice = Number(p['Purchase Price']) || 0;
      if (purchasePrice <= 0) {
        unresolved++;
        return;
      }
      createLot_(p['Product ID'], p['Product Name'], 'OPENING-MIGRATION', p['Created At'] || new Date(), purchasePrice, stock, '', '', p['Selling Price']);
      created++;
    });

    SpreadsheetApp.flush();
    ui.alert(
      'Stock Lots migration complete',
      'Created: ' + created + ' opening lot(s).\n' +
        'Unresolved: ' + unresolved + ' product(s) have positive stock but no Purchase Price.\n' +
        'Products with existing lots or zero stock were left untouched.',
      ui.ButtonSet.OK
    );
    return ok_({ created: created, unresolved: unresolved });
  } catch (err) {
    logError_('migrateOpeningStockLots', err);
    ui.alert('Something went wrong: ' + err.message);
    return fail_(err.message);
  } finally {
    lock.releaseLock();
  }
}

/**
 * Read-only inverse of the exact physical quantity restored by a completed
 * Sales Return. Does NOT re-run FIFO: this would take stock from a different
 * purchase lot and corrupt SALE_ITEM_LOTS consumption evidence.
 *
 * Legacy rows without a lineage ID are only reversible when exactly one
 * original consumption row matches invoice/product/lot/source-product.
 * Returned fallback lots are reversible only when their sole source is this
 * Return ID and they still have the necessary quantity.
 */
function planSalesReturnStockUndo_(returnId, context) {
  const opts = context || {};
  const id = String(returnId || '').trim();
  const headers = opts.returnHeaders || getAllRows_('SALES_RETURN');
  const matches = headers.filter(function(r){ return String(r['Return ID']) === id && !isDeleted_(r); });
  if (matches.length !== 1) throw new Error(matches.length ? 'Duplicate Sales Return ID. Needs Review.' : 'Sales Return not found.');
  const header = matches[0], invoiceId = String(header['Invoice ID']);
  const items = (opts.returnItems || getAllRows_('SALES_RETURN_ITEMS')).filter(function(i){
    return String(i['Return ID']) === id && !isDeleted_(i);
  });
  if (!items.length) throw new Error('Return has no active lines. Needs Review.');
  const products = opts.products || getAllRows_('PRODUCTS');
  const lots = opts.stockLots || getAllRows_('STOCK_LOTS');
  const consumed = opts.consumptionRows || getAllRows_('SALE_ITEM_LOTS');
  const bundleSnapshots = typeof getSaleBundleSnapshot_ === 'function'
    ? getSaleBundleSnapshot_(invoiceId, opts.bundleSnapshotRows || getAllRows_('SALE_BUNDLE_COMPONENTS')) : {};

  const expected = {};
  function key(productId, sourceId) { return String(productId) + '|' + String(sourceId); }
  items.forEach(function(item){
    const sourceId = String(item['Product ID']), qty = Number(item['Return Quantity']);
    if (!Number.isFinite(qty) || qty <= 0) throw new Error('Invalid returned line quantity. Needs Review.');
    // Damaged lines never restored stock or lots, so no stock movement undo applies to them.
    if (String(item['Condition'] || '').trim().toLowerCase() === 'damaged') return;
    if (item['Sold Product Type'] === 'Bundle') {
      const snap = bundleSnapshots[sourceId];
      if (!snap || !snap.components || !snap.components.length) throw new Error('Bundle return source recipe missing. Needs Review.');
      snap.components.forEach(function(c){
        const k = key(c.productId, sourceId);
        expected[k] = (expected[k] || 0) + qty * Number(c.qtyPerSet);
      });
    } else {
      const k = key(sourceId, sourceId);
      expected[k] = (expected[k] || 0) + qty;
    }
  });
  if (!Object.keys(expected).length) {
    return { returnId: id, invoiceId: invoiceId, productDeltas: [], lotDeltas: [], saleConsumptionDeltas: [], movements: [] };
  }
  const movements = (opts.movements || getAllRows_('STOCK_MOVEMENT')).filter(function(m){
    return m['Type'] === 'Sales Return' && String(m['Reference']) === id && !m['Reversed By'];
  });
  if (!movements.length) throw new Error('Return stock movement evidence missing. Needs Review.');

  const actual = {}, productGroups = {}, lotGroups = {}, consumptionGroups = {}, movePlans = {};
  const seenMovementIds = {};
  movements.forEach(function(m) {
    const movementId = String(m['Movement ID'] || '');
    const productId = String(m['Product ID'] || '');
    const sourceId = String(m['Source Sale Product ID'] || productId);
    const lotId = String(m['Lot ID'] || '');
    const qty = Number(m['Quantity In']);
    if (!movementId || seenMovementIds[movementId] || !productId || !lotId ||
        !Number.isFinite(qty) || qty <= 0 || Number(m['Quantity Out'] || 0) !== 0)
      throw new Error('Invalid or duplicate Return stock movement evidence. Needs Review.');
    seenMovementIds[movementId] = true;
    const k = key(productId, sourceId);
    actual[k] = (actual[k] || 0) + qty;

    const productRows = products.filter(function(p){return String(p['Product ID']) === productId && !isDeleted_(p);});
    const lotRows = lots.filter(function(row){return String(row['Lot ID']) === lotId && String(row['Product ID']) === productId;});
    if (productRows.length !== 1 || lotRows.length !== 1)
      throw new Error('Missing or ambiguous stock product/lot evidence. Needs Review.');
    const product = productRows[0], lot = lotRows[0];
    const link = String(m['Source Consumption Link ID'] || '');
    // A fallback restoration creates a NEW lot owned by this Return ID.
    // Its original consumed lot must be traced through the immutable link,
    // not mistaken for the newly created restoration lot ID.
    const isReturnOwnedFallback = String(lot['Purchase ID'] || '') === id;
    const candidates = consumed.filter(function(c){
      return String(c['Invoice ID']) === invoiceId &&
        String(c['Product ID']) === productId &&
        String(c['Source Sale Product ID'] || c['Product ID']) === sourceId &&
        (!link || String(c['Return Consumption Link ID'] || '') === link) &&
        (String(c['Lot ID']) === lotId || (isReturnOwnedFallback && !!link));
    });
    let sourceRow = null;
    if (candidates.length === 1) sourceRow = candidates[0];
    else if (candidates.length > 1 || link)
      throw new Error('Ambiguous original sale consumption evidence. Needs Review.');
    else if (String(lot['Purchase ID'] || '') !== id)
      throw new Error('Original sale consumption evidence missing. Needs Review.');
    if (!productGroups[productId]) productGroups[productId] = {productId:productId,rowIndex:product._rowIndex,newStock:Number(product['Current Stock'])||0,qty:0};
    productGroups[productId].qty += qty;
    if (!lotGroups[lotId]) lotGroups[lotId] = {
      lotId:lotId, productId:productId, rowIndex:lot._rowIndex, lotRow:lot,
      newRemaining:Number(lot['Remaining Quantity'])||0, qty:0,
      oversold:String(lot['Purchase ID'] || '').toUpperCase() === 'OVERSOLD',
      isReturnOwnedFallback:isReturnOwnedFallback,
      settledQty:isReturnOwnedFallback ? settledQuantityOfLot_(lot) : 0,
      reopenQty:0,
      restoreSettlementEntries:[]
    };
    lotGroups[lotId].qty += qty;
    if (sourceRow) {
      if (!isReturnOwnedFallback && String(sourceRow['Settled From Lot ID'] || '')) {
        const settledFromId = String(sourceRow['Settled From Lot ID']);
        const oversoldTarget = lots.filter(function(l){ return String(l['Lot ID']) === settledFromId; })[0];
        lotGroups[lotId].restoreSettlementEntries.push({
          lotId: settledFromId,
          qty: qty,
          prevCost: oversoldTarget ? (Number(oversoldTarget['Purchase Price']) || 0) : (Number(sourceRow['Unit Cost']) || 0)
        });
      }
      const rowKey = String(sourceRow._rowIndex);
      if (!consumptionGroups[rowKey]) consumptionGroups[rowKey] = {
        rowIndex:sourceRow._rowIndex,newQuantity:Number(sourceRow['Quantity'])||0,qty:0
      };
      consumptionGroups[rowKey].qty += qty;
    }
    movePlans[movementId] = {rowIndex:m._rowIndex,movementId:movementId,productId:productId,productName:product['Product Name'],
      lotId:lotId,sourceId:sourceId,qty:qty};
  });
  const expectedKeys = Object.keys(expected), actualKeys = Object.keys(actual);
  if (expectedKeys.length !== actualKeys.length || expectedKeys.some(function(k){
    return Math.abs((expected[k] || 0) - (actual[k] || 0)) > 1e-8;
  })) throw new Error('Return stock movement quantity mismatch. Needs Review.');

  const oversoldOrReopenByProduct = {};
  const lotDeltas = Object.keys(lotGroups).map(function(k){
    const g = lotGroups[k];
    const prevRem = g.newRemaining;
    if (g.oversold) {
      g.newRemaining = prevRem - g.qty;
      oversoldOrReopenByProduct[g.productId] = (oversoldOrReopenByProduct[g.productId] || 0) + g.qty;
    } else if (g.isReturnOwnedFallback && g.settledQty > 0) {
      const avail = prevRem + g.settledQty;
      if (g.qty > avail + 1e-8) throw new Error('Returned lot has already been consumed; stock reversal blocked.');
      g.reopenQty = Math.max(0, g.qty - prevRem);
      g.newRemaining = Math.max(0, prevRem - g.qty);
      oversoldOrReopenByProduct[g.productId] = (oversoldOrReopenByProduct[g.productId] || 0) + g.reopenQty;
    } else {
      g.newRemaining = prevRem - g.qty;
      if (g.newRemaining < -1e-8) throw new Error('Returned lot has already been consumed; stock reversal blocked.');
    }
    return g;
  });
  const productDeltas = Object.keys(productGroups).map(function(k){
    const g = productGroups[k];
    g.newStock -= g.qty;
    const allowNegative = (oversoldOrReopenByProduct[g.productId] || 0) > 1e-8;
    if (g.newStock < -1e-8 && !allowNegative) throw new Error('Insufficient current product stock to reverse this return.');
    return g;
  });
  const saleConsumptionDeltas = Object.keys(consumptionGroups).map(function(k){
    const g=consumptionGroups[k];g.newQuantity+=g.qty;return g;
  });
  return {returnId:id,invoiceId:invoiceId,productDeltas:productDeltas,lotDeltas:lotDeltas,
    saleConsumptionDeltas:saleConsumptionDeltas,movements:Object.keys(movePlans).map(function(k){return movePlans[k];})};
}

/** Called only under ScriptLock after complete validation and journal reservation. */
function applySalesReturnStockUndo_(plan, operationId, operationType) {
  const now = new Date();
  (plan.productDeltas || []).forEach(function(g){
    updateRowFields_('PRODUCTS',g.rowIndex,{'Current Stock':g.newStock,'Updated At':now});
  });
  (plan.lotDeltas || []).forEach(function(g){
    if (g.reopenQty > 0 && g.lotRow) {
      reopenOversoldDebt_(g.lotRow, g.reopenQty);
    }
    const nextStatus = g.newRemaining < 0 ? 'Oversold'
      : (g.isReturnOwnedFallback && g.newRemaining === 0 ? 'Deleted'
        : (g.newRemaining === 0 ? (g.oversold ? 'Settled' : 'Consumed') : 'Active'));
    updateRowFields_('STOCK_LOTS',g.rowIndex,{'Remaining Quantity':g.newRemaining,'Status':nextStatus});
    if (g.restoreSettlementEntries && g.restoreSettlementEntries.length && g.lotRow) {
      g.restoreSettlementEntries.forEach(function(e){
        addLotSettlementLog_(g.lotRow, e.lotId, e.qty, e.prevCost);
      });
    }
  });
  (plan.saleConsumptionDeltas || []).forEach(function(g){
    updateRowFields_('SALE_ITEM_LOTS',g.rowIndex,{'Quantity':g.newQuantity});
  });
  (plan.movements || []).forEach(function(m){
    updateRowFields_('STOCK_MOVEMENT',m.rowIndex,{'Reversed By':operationId,'Reversed At':now});
    const pd = plan.productDeltas.filter(function(p){return p.productId===m.productId;})[0];
    appendRow_('STOCK_MOVEMENT',{
      'Movement ID':generateId_('STOCK_MOVEMENT'),
      'Date':now,'Product ID':m.productId,'Product Name':m.productName,
      'Type':'Sales Return '+operationType+' Reversal','Reference':plan.returnId,
      'Quantity In':'','Quantity Out':m.qty,'Balance Stock':pd.newStock,
      'Lot ID':m.lotId,'Source Sale Product ID':m.sourceId,
      'Notes':'Correction '+operationId
    });
  });
}


/* =====================================================================
 * ONE-TIME OVERSOLD LEDGER REPAIR
 * ---------------------------------------------------------------------
 * Fixes data written BEFORE settleOversoldLots_ existed: oversold (negative)
 * lots sitting next to positive lots, oversold/returned lots carrying a stale
 * cost, and products whose Purchase Price never followed their purchases.
 *
 *   previewOversoldLotRepair(token)  - read-only, lists every change.
 *   applyOversoldLotRepair(token)    - writes exactly what the preview listed.
 *
 * Current Stock is NOT changed: settling moves quantity between lots only, so
 * the lot total still equals Products.Current Stock. Sale Item Lots 'Unit
 * Cost' IS changed for settled oversold lots, so historical COGS/profit moves.
 * ===================================================================== */

function isInboundLotSource_(purchaseId) {
  return /^(PUR-|ADJUSTMENT|OPENING)/i.test(String(purchaseId || '').trim());
}

function planOversoldLotRepair_() {
  const products = getAllRows_('PRODUCTS');
  const lots = getAllRows_('STOCK_LOTS').filter(function (l) {
    return String(l['Status'] || '').toLowerCase() !== 'deleted';
  });
  const saleRows = getAllRows_('SALE_ITEM_LOTS');
  const movements = getAllRows_('STOCK_MOVEMENT').filter(function (m) { return m['Type'] === 'Sales Return'; });
  const salesByLot = {};
  saleRows.forEach(function (r) {
    const id = String(r['Lot ID'] || '');
    if (!id) return;
    (salesByLot[id] = salesByLot[id] || []).push(r);
  });

  const lotUpdates = {};   // lotId -> { row, remaining, cost, status, notes }
  const productUpdates = [];
  const report = { products: [], lotChanges: [], saleCostChanges: [], returnLotRecosts: [], productPriceChanges: [], totals: { settledQty: 0, cogsDelta: 0 } };
  const newCostByLot = {};
  const logAdds = {};   // absorbing lot -> settlement entries to append

  const byProduct = {};
  lots.forEach(function (l) { (byProduct[l['Product ID']] = byProduct[l['Product ID']] || []).push(l); });

  Object.keys(byProduct).forEach(function (productId) {
    const pl = byProduct[productId].slice().sort(compareLotsFifo_);
    const neg = pl.filter(function (l) { return (Number(l['Remaining Quantity']) || 0) < 0; });
    const pos = pl.filter(function (l) { return (Number(l['Remaining Quantity']) || 0) > 0; });
    if (!neg.length || !pos.length) return;
    const virtual = {};
    pl.forEach(function (l) { virtual[l['Lot ID']] = Number(l['Remaining Quantity']) || 0; });

    neg.forEach(function (n) {
      // Cost = the first real inbound lot AFTER the oversold sale (the restock).
      const restock = pl.filter(function (l) {
        return isInboundLotSource_(l['Purchase ID']) && (Number(l['Purchase Price']) || 0) > 0 && compareLotsFifo_(l, n) > 0;
      })[0];
      const cost = restock ? Number(restock['Purchase Price']) : latestKnownLotCost_(productId, pl, null);
      let debt = -virtual[n['Lot ID']];
      pos.forEach(function (p) {
        if (debt <= 0) return;
        const avail = virtual[p['Lot ID']];
        if (avail <= 0) return;
        const take = Math.min(avail, debt);
        virtual[p['Lot ID']] -= take;
        virtual[n['Lot ID']] += take;
        debt -= take;
        report.totals.settledQty += take;
        (logAdds[p['Lot ID']] = logAdds[p['Lot ID']] || []).push({ lotId: n['Lot ID'], qty: take, prevCost: Number(n['Purchase Price']) || 0 });
      });
      if (virtual[n['Lot ID']] !== (Number(n['Remaining Quantity']) || 0) && cost > 0) newCostByLot[n['Lot ID']] = cost;
    });

    pl.forEach(function (l) {
      const before = Number(l['Remaining Quantity']) || 0, after = virtual[l['Lot ID']];
      const newCost = newCostByLot[l['Lot ID']];
      if (before === after && newCost === undefined) return;
      const status = after < 0 ? 'Oversold' : (before < 0 ? 'Settled' : (after > 0 ? (l['Status'] || 'Active') : 'Consumed'));
      lotUpdates[l['Lot ID']] = { row: l, remaining: after, cost: newCost, status: status,
        log: logAdds[l['Lot ID']] ? formatSettlementLog_(parseSettlementLog_(l['Settlement Log']).concat(logAdds[l['Lot ID']])) : undefined };
      report.lotChanges.push({
        productId: productId, lotId: l['Lot ID'], purchaseId: l['Purchase ID'],
        remainingBefore: before, remainingAfter: after,
        costBefore: Number(l['Purchase Price']) || 0, costAfter: newCost !== undefined ? newCost : (Number(l['Purchase Price']) || 0)
      });
    });
    report.products.push(productId);
  });

  // Re-cost the sales that drew from each re-costed oversold lot.
  Object.keys(newCostByLot).forEach(function (lotId) {
    (salesByLot[lotId] || []).forEach(function (r) {
      const oldCost = Number(r['Unit Cost']) || 0, newCost = newCostByLot[lotId];
      if (Math.abs(oldCost - newCost) < 0.0000001) return;
      const qty = Number(r['Quantity']) || 0;
      report.saleCostChanges.push({ rowIndex: r._rowIndex, invoiceId: r['Invoice ID'], lotId: lotId, qty: qty, costBefore: oldCost, costAfter: newCost });
      report.totals.cogsDelta += qty * (newCost - oldCost);
    });
  });

  // Return lots still holding stock take the (now corrected) cost of the sale they came from.
  lots.forEach(function (l) {
    if (!/^SRT-/i.test(String(l['Purchase ID'] || '')) || (Number(l['Remaining Quantity']) || 0) <= 0) return;
    const move = movements.filter(function (m) { return String(m['Lot ID']) === String(l['Lot ID']) && m['Source Consumption Link ID']; })[0];
    if (!move) return;
    const src = saleRows.filter(function (r) { return String(r['Return Consumption Link ID'] || '') === String(move['Source Consumption Link ID']); })[0];
    if (!src) return;
    const cost = newCostByLot[String(src['Lot ID'])] !== undefined ? newCostByLot[String(src['Lot ID'])] : (Number(src['Unit Cost']) || 0);
    if (cost > 0 && Math.abs(cost - (Number(l['Purchase Price']) || 0)) > 0.0000001) {
      const u = lotUpdates[l['Lot ID']] || (lotUpdates[l['Lot ID']] = { row: l, remaining: Number(l['Remaining Quantity']) || 0, status: l['Status'] });
      report.returnLotRecosts.push({ lotId: l['Lot ID'], costBefore: Number(l['Purchase Price']) || 0, costAfter: cost });
      u.cost = cost;
    }
  });

  // Product Purchase Price = cost of the latest real purchase.
  products.forEach(function (p) {
    const latest = (byProduct[p['Product ID']] || []).filter(function (l) {
      return /^PUR-/i.test(String(l['Purchase ID'] || '')) && (Number(l['Purchase Price']) || 0) > 0;
    }).sort(compareLotsFifo_).pop();
    if (!latest) return;
    const price = Number(latest['Purchase Price']);
    if (Math.abs(price - (Number(p['Purchase Price']) || 0)) < 0.0000001) return;
    productUpdates.push({ row: p, price: price });
    report.productPriceChanges.push({ productId: p['Product ID'], name: p['Product Name'], before: Number(p['Purchase Price']) || 0, after: price });
  });

  report.totals.cogsDelta = roundMoney_(report.totals.cogsDelta);
  return { report: report, lotUpdates: lotUpdates, productUpdates: productUpdates };
}

function previewOversoldLotRepair(token) {
  try {
    requirePermission_(token, 'products', 'edit');
    return ok_(planOversoldLotRepair_().report);
  } catch (err) {
    logError_('previewOversoldLotRepair', err);
    return fail_(err.message);
  }
}

function applyOversoldLotRepair(token) {
  const lock = LockService.getScriptLock();
  lock.waitLock(CONFIG.LOCK_TIMEOUT_MS);
  try {
    requirePermission_(token, 'products', 'edit');
    const plan = planOversoldLotRepair_();
    Object.keys(plan.lotUpdates).forEach(function (lotId) {
      const u = plan.lotUpdates[lotId];
      const fields = { 'Remaining Quantity': u.remaining, 'Status': u.status };
      if (u.cost !== undefined) fields['Purchase Price'] = u.cost;
      if (u.log !== undefined) fields['Settlement Log'] = u.log;
      updateRowFields_('STOCK_LOTS', u.row._rowIndex, fields);
    });
    plan.report.saleCostChanges.forEach(function (c) {
      updateRowFields_('SALE_ITEM_LOTS', c.rowIndex, { 'Unit Cost': c.costAfter });
    });
    plan.productUpdates.forEach(function (u) {
      updateRowFields_('PRODUCTS', u.row._rowIndex, { 'Purchase Price': u.price, 'Updated At': new Date() });
    });
    SpreadsheetApp.flush();
    return ok_(plan.report);
  } catch (err) {
    logError_('applyOversoldLotRepair', err);
    return fail_(err.message);
  } finally {
    lock.releaseLock();
  }
}

/**
 * Google Sheets menu entry (Hardware ERP -> Repair Oversold Stock Lots (Preview)).
 * Shows a read-only preview of every lot/COGS/price update first and applies
 * only after explicit YES confirmation.
 */
function runOversoldLotRepairMenu_() {
  const ui = SpreadsheetApp.getUi();
  try {
    const plan = planOversoldLotRepair_();
    const r = plan.report;
    const totalChanges =
      (r.lotChanges ? r.lotChanges.length : 0) +
      (r.saleCostChanges ? r.saleCostChanges.length : 0) +
      (r.returnLotRecosts ? r.returnLotRecosts.length : 0) +
      (r.productPriceChanges ? r.productPriceChanges.length : 0);

    if (!totalChanges) {
      ui.alert(
        'Oversold Stock Lots Repair',
        'No oversold lot conflicts, stale return lot costs, or stale product purchase prices were found. Everything is clean!',
        ui.ButtonSet.OK
      );
      return;
    }

    const lines = [];
    lines.push('Affected products: ' + r.products.length);
    lines.push('Lot quantity/cost updates: ' + r.lotChanges.length + ' (settled qty: ' + r.totals.settledQty + ')');
    lines.push('Historical sale COGS updates: ' + r.saleCostChanges.length + ' (COGS delta: ' + r.totals.cogsDelta + ')');
    lines.push('Return lot recosts: ' + r.returnLotRecosts.length);
    lines.push('Product Purchase Price updates: ' + r.productPriceChanges.length);

    if (r.lotChanges.length) {
      lines.push('\nSample lot changes:');
      r.lotChanges.slice(0, 6).forEach(function (c) {
        lines.push('• ' + c.lotId + ' (' + c.purchaseId + '): rem ' + c.remainingBefore + ' -> ' + c.remainingAfter + ', cost ' + c.costBefore + ' -> ' + c.costAfter);
      });
    }
    if (r.productPriceChanges.length) {
      lines.push('\nSample product price updates:');
      r.productPriceChanges.slice(0, 6).forEach(function (c) {
        lines.push('• ' + c.name + ': ' + c.before + ' -> ' + c.after);
      });
    }
    lines.push('\nDo you want to apply these changes now?');

    const answer = ui.alert('Preview: Oversold Stock Lots Repair', lines.join('\n'), ui.ButtonSet.YES_NO);
    if (answer !== ui.Button.YES) {
      ui.alert('Cancelled', 'No changes were made.', ui.ButtonSet.OK);
      return;
    }

    const lock = LockService.getScriptLock();
    lock.waitLock(CONFIG.LOCK_TIMEOUT_MS);
    try {
      const fresh = planOversoldLotRepair_();
      Object.keys(fresh.lotUpdates).forEach(function (lotId) {
        const u = fresh.lotUpdates[lotId];
        const fields = { 'Remaining Quantity': u.remaining, 'Status': u.status };
        if (u.cost !== undefined) fields['Purchase Price'] = u.cost;
        if (u.log !== undefined) fields['Settlement Log'] = u.log;
        updateRowFields_('STOCK_LOTS', u.row._rowIndex, fields);
      });
      fresh.report.saleCostChanges.forEach(function (c) {
        updateRowFields_('SALE_ITEM_LOTS', c.rowIndex, { 'Unit Cost': c.costAfter });
      });
      fresh.productUpdates.forEach(function (u) {
        updateRowFields_('PRODUCTS', u.row._rowIndex, { 'Purchase Price': u.price, 'Updated At': new Date() });
      });
      SpreadsheetApp.flush();
      ui.alert(
        'Repair Complete',
        'Updated ' + fresh.report.lotChanges.length + ' lot(s), ' +
        fresh.report.saleCostChanges.length + ' sale cost row(s), and ' +
        fresh.report.productPriceChanges.length + ' product purchase price(s).',
        ui.ButtonSet.OK
      );
    } finally {
      lock.releaseLock();
    }
  } catch (err) {
    logError_('runOversoldLotRepairMenu_', err);
    ui.alert('Repair Failed', err.message, ui.ButtonSet.OK);
  }
}


/* =====================================================================
 * VIEW LOTS: lots + FULL stock movement + editable lot sale price
 * ===================================================================== */

/**
 * Everything the Products "View Lots" dialog shows for one product: its lots
 * (with sale price), the complete stock movement history of EVERY type
 * (Purchase, Sale, Sales Return, Adjustment, Opening Stock, Deleted/Reversed
 * entries, Vendor movements...), and whether this user may edit lot prices.
 * Read-only; getProductLots is reused unchanged for the lot rows.
 */
function getProductLotsView(token, productId) {
  try {
    const user = requirePermission_(token, 'products', 'view');
    const id = sanitizeInput_(productId);
    if (!id) return fail_('Product ID is required.');
    const lotsResult = getProductLots(token, id);
    if (!lotsResult.success) return lotsResult;

    const movements = getAllRows_('STOCK_MOVEMENT')
      .filter(function (m) { return m['Product ID'] === id; })
      .sort(function (a, b) {
        const da = String(a['Date'] || ''), db = String(b['Date'] || '');
        if (da < db) return -1;
        if (da > db) return 1;
        return a._rowIndex - b._rowIndex;
      })
      .map(function (m) {
        const qtyIn = m['Quantity In'], qtyOut = m['Quantity Out'];
        return {
          movementId: m['Movement ID'] || '',
          date: m['Date'] || '',
          type: m['Type'] || '',
          reference: m['Reference'] || '',
          qtyIn: (qtyIn === '' || qtyIn === null || qtyIn === undefined) ? null : Number(qtyIn) || 0,
          qtyOut: (qtyOut === '' || qtyOut === null || qtyOut === undefined) ? null : Number(qtyOut) || 0,
          balance: (m['Balance Stock'] === '' || m['Balance Stock'] === null || m['Balance Stock'] === undefined) ? null : Number(m['Balance Stock']) || 0,
          notes: m['Notes'] || '',
          lotId: m['Lot ID'] || '',
          reversed: !!m['Reversed By']
        };
      });

    return ok_({
      lots: lotsResult.data,
      movements: movements,
      canEditPrice: hasPermission_(user, 'products', 'edit')
    });
  } catch (err) {
    logError_('getProductLotsView', err);
    return fail_(err.message);
  }
}

/**
 * Changes the SALE price of one stock lot. POS sells a lot's remaining stock
 * at its own sale price, so this changes what future sales of that stock
 * charge. It never touches past invoices, stock quantity or purchase cost.
 * Only lots that still hold stock can be repriced (a depleted lot has
 * nothing left to sell).
 */
function updateStockLotSellPrice(token, lotId, newSellPrice) {
  const lock = LockService.getScriptLock();
  lock.waitLock(CONFIG.LOCK_TIMEOUT_MS);
  try {
    const user = requirePermission_(token, 'products', 'edit');
    const id = sanitizeInput_(lotId);
    if (!id) return fail_('Lot ID is required.');
    if (!isValidNonNegativeNumber_(newSellPrice)) return fail_('Enter a valid sale price (0 or more).');
    const price = roundMoney_(Number(newSellPrice));

    const lot = getAllRows_('STOCK_LOTS').filter(function (l) { return l['Lot ID'] === id; })[0];
    if (!lot) return fail_('Lot not found.');
    if (String(lot['Status'] || '').toLowerCase() === 'deleted') return fail_('This lot has been deleted.');
    if ((Number(lot['Remaining Quantity']) || 0) <= 0) {
      return fail_('Only a lot that still holds stock can be repriced. This lot has no stock left to sell.');
    }
    const product = getAllRows_('PRODUCTS').filter(function (p) { return p['Product ID'] === lot['Product ID']; })[0] || null;
    const oldPrice = lotSellPrice_(lot, product);
    if (Math.abs(oldPrice - price) < 0.0000001) return ok_({ lotId: id, sellPrice: price, changed: false });

    updateRowFields_('STOCK_LOTS', lot._rowIndex, { 'Sell Price': price });
    try {
      appendRow_('LOGS', {
        'Timestamp': new Date(),
        'Context': 'StockLotSellPrice',
        'Message': id + ' (' + lot['Product ID'] + ' ' + (lot['Product Name'] || '') + '): sale price ' +
          oldPrice + ' -> ' + price + ' by ' + actorName_(user)
      });
    } catch (logErr) { /* the audit line is best effort; the price change itself is done */ }
    return ok_({ lotId: id, sellPrice: price, changed: true, previousSellPrice: oldPrice });
  } catch (err) {
    logError_('updateStockLotSellPrice', err);
    return fail_(err.message);
  } finally {
    lock.releaseLock();
  }
}
