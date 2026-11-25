'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createGasEnvironment, mustOk } = require('./helpers/gasHarness');

test('Chronological FIFO Guard (Sale): backdated sale draws only from on-or-before-date lots and blocks consuming future lots', () => {
  const { ctx, token, advanceSeconds } = createGasEnvironment({ nowIso: '2026-11-20T10:00:00+06:00' });
  mustOk(ctx.startCashSession(token, 100000, 'Open'));
  const sup = mustOk(ctx.addSupplier(token, { name: 'Sup Chrono', openingBalance: 0 }));
  const vendor = mustOk(ctx.addVendor(token, { name: 'Vendor Chrono', phone: '01788880000' }));
  const prod = mustOk(ctx.addProduct(token, { name: 'Brass Pipe', purchasePrice: 100, sellingPrice: 160, stock: 0, minStock: 1 }));

  // Purchase 1 on Nov 05: 5 @ 100
  const pur1 = mustOk(ctx.createPurchase(token, {
    supplierId: sup.id, date: '2026-11-05', backdatedReason: 'Old bill', discount: 0, paidAmount: 500, paymentMethod: 'Cash',
    items: [{ productId: prod.id, name: 'Brass Pipe', qty: 5, unitPrice: 100, sellingPrice: 160 }]
  }));
  advanceSeconds(5);

  // Purchase 2 on Nov 15: 10 @ 140
  const pur2 = mustOk(ctx.createPurchase(token, {
    supplierId: sup.id, date: '2026-11-15', backdatedReason: 'Later bill', discount: 0, paidAmount: 1400, paymentMethod: 'Cash',
    items: [{ productId: prod.id, name: 'Brass Pipe', qty: 10, unitPrice: 140, sellingPrice: 180 }]
  }));
  advanceSeconds(5);

  // 1. Backdated sale on Nov 10 for 4 units -> MUST succeed using Nov 05 lot ONLY
  const sale1 = mustOk(ctx.completeSale(token, {
    customerName: 'Cust 1', customerPhone: '01711110001', paymentType: 'Cash', paymentMethod: 'Cash', discount: 0,
    date: '2026-11-10', backdatedReason: 'Missed bill',
    items: [{ productId: prod.id, name: 'Brass Pipe', qty: 4, unitPrice: 160, priceMode: 'manual' }]
  }));
  advanceSeconds(5);

  const lot1 = ctx.getAllRows_('STOCK_LOTS').find(l => l['Purchase ID'] === pur1.purchaseId);
  const lot2 = ctx.getAllRows_('STOCK_LOTS').find(l => l['Purchase ID'] === pur2.purchaseId);
  assert.equal(lot1['Remaining Quantity'], 1);
  assert.equal(lot2['Remaining Quantity'], 10);

  // 2. Backdated sale on Nov 10 for 3 units (only 1 existed on Nov 10; 10 more arrived on Nov 15) -> MUST BE BLOCKED!
  const beforeInvoices = ctx.getAllRows_('SALES').length;
  const blocked = ctx.completeSale(token, {
    customerName: 'Cust 2', customerPhone: '01711110002', paymentType: 'Cash', paymentMethod: 'Cash', discount: 0,
    date: '2026-11-10', backdatedReason: 'Late entry',
    items: [{ productId: prod.id, name: 'Brass Pipe', qty: 3, unitPrice: 160, priceMode: 'manual' }]
  });
  assert.equal(blocked.success, false, 'Backdated sale must NOT consume future-dated Nov 15 lot');
  assert.match(blocked.message, /2026-11-10|2026-11-15|later purchase|future/i);
  assert.equal(ctx.getAllRows_('SALES').length, beforeInvoices, 'Rejected sale must write nothing');
  assert.equal(ctx.getAllRows_('STOCK_LOTS').find(l => l['Purchase ID'] === pur1.purchaseId)['Remaining Quantity'], 1);
  assert.equal(ctx.getAllRows_('STOCK_LOTS').find(l => l['Purchase ID'] === pur2.purchaseId)['Remaining Quantity'], 10);

  // 3. Backdated sale on Nov 10 for 3 units WITH vendor consignment -> draws 1 from Nov 05 lot + 2 from vendor, leaving Nov 15 lot untouched!
  mustOk(ctx.completeSale(token, {
    customerName: 'Cust 3', customerPhone: '01711110003', paymentType: 'Cash', paymentMethod: 'Cash', discount: 0,
    date: '2026-11-10', backdatedReason: 'Vendor backed',
    items: [{ productId: prod.id, name: 'Brass Pipe', qty: 3, unitPrice: 160, priceMode: 'manual', vendorId: vendor.id, vendorUnitCost: 130 }]
  }));
  assert.equal(ctx.getAllRows_('STOCK_LOTS').find(l => l['Purchase ID'] === pur1.purchaseId)['Remaining Quantity'], 0);
  assert.equal(ctx.getAllRows_('STOCK_LOTS').find(l => l['Purchase ID'] === pur2.purchaseId)['Remaining Quantity'], 10, 'Future Nov 15 lot must remain untouched');
  const vs = ctx.activeRows_('VENDOR_SOURCING');
  assert.equal(vs.length, 1);
  assert.equal(vs[0]['Quantity'], 2);

  // Sanity: Opening stock created today is ALWAYS eligible for backdated sales
  const openingProd = mustOk(ctx.addProduct(token, { name: 'Opening Washer', purchasePrice: 20, sellingPrice: 35, stock: 5, minStock: 1 }));
  mustOk(ctx.completeSale(token, {
    customerName: 'Cust 4', customerPhone: '01711110004', paymentType: 'Cash', paymentMethod: 'Cash', discount: 0,
    date: '2026-11-10', backdatedReason: 'Historical opening sale',
    items: [{ productId: openingProd.id, name: 'Opening Washer', qty: 3, unitPrice: 35, priceMode: 'manual' }]
  }));
  assert.equal(ctx.getAllRows_('PRODUCTS').find(p => p['Product ID'] === openingProd.id)['Current Stock'], 2);
});

test('Chronological FIFO Guard (Purchase): blocks backdated purchase earlier than an already-sold newer lot, allows when newer lot is unsold or settling oversold', () => {
  const { ctx, token, advanceSeconds } = createGasEnvironment({ nowIso: '2026-11-20T10:00:00+06:00' });
  mustOk(ctx.startCashSession(token, 100000, 'Open'));
  const sup = mustOk(ctx.addSupplier(token, { name: 'Sup Chrono 2', openingBalance: 0 }));

  // Product A: Purchase on Nov 10 -> Sold on Nov 15 -> Backdated purchase on Nov 05 MUST BE BLOCKED
  const prodA = mustOk(ctx.addProduct(token, { name: 'Gate Valve', purchasePrice: 100, sellingPrice: 160, stock: 0, minStock: 1 }));
  mustOk(ctx.createPurchase(token, {
    supplierId: sup.id, date: '2026-11-10', backdatedReason: 'Bill 1', discount: 0, paidAmount: 500, paymentMethod: 'Cash',
    items: [{ productId: prodA.id, name: 'Gate Valve', qty: 5, unitPrice: 100, sellingPrice: 160 }]
  }));
  advanceSeconds(5);
  mustOk(ctx.completeSale(token, {
    customerName: 'Buyer A', customerPhone: '01722220001', paymentType: 'Cash', paymentMethod: 'Cash', discount: 0,
    date: '2026-11-15', backdatedReason: 'Sale 1',
    items: [{ productId: prodA.id, name: 'Gate Valve', qty: 2, unitPrice: 160, priceMode: 'manual' }]
  }));
  advanceSeconds(5);

  const purchasesBefore = ctx.getAllRows_('PURCHASES').length;
  const blockedPur = ctx.createPurchase(token, {
    supplierId: sup.id, date: '2026-11-05', backdatedReason: 'Forgot old bill', discount: 0, paidAmount: 400, paymentMethod: 'Cash',
    items: [{ productId: prodA.id, name: 'Gate Valve', qty: 5, unitPrice: 80, sellingPrice: 160 }]
  });
  assert.equal(blockedPur.success, false, 'Backdated purchase before an already-sold newer lot must be blocked');
  assert.match(blockedPur.message, /Gate Valve|2026-11-05|2026-11-10|FIFO/i);
  assert.equal(ctx.getAllRows_('PURCHASES').length, purchasesBefore, 'Blocked purchase must write nothing');

  // Product B: Purchase on Nov 10 (UNSOLD) -> Backdated purchase on Nov 05 MUST BE ALLOWED & consumed first
  const prodB = mustOk(ctx.addProduct(token, { name: 'Check Valve', purchasePrice: 100, sellingPrice: 160, stock: 0, minStock: 1 }));
  mustOk(ctx.createPurchase(token, {
    supplierId: sup.id, date: '2026-11-10', backdatedReason: 'Bill B1', discount: 0, paidAmount: 500, paymentMethod: 'Cash',
    items: [{ productId: prodB.id, name: 'Check Valve', qty: 5, unitPrice: 100, sellingPrice: 160 }]
  }));
  advanceSeconds(5);
  mustOk(ctx.createPurchase(token, {
    supplierId: sup.id, date: '2026-11-05', backdatedReason: 'Older bill B0', discount: 0, paidAmount: 400, paymentMethod: 'Cash',
    items: [{ productId: prodB.id, name: 'Check Valve', qty: 5, unitPrice: 80, sellingPrice: 160 }]
  }));
  advanceSeconds(5);
  const saleB = mustOk(ctx.completeSale(token, {
    customerName: 'Buyer B', customerPhone: '01722220002', paymentType: 'Cash', paymentMethod: 'Cash', discount: 0,
    date: '2026-11-20', items: [{ productId: prodB.id, name: 'Check Valve', qty: 3, unitPrice: 160, priceMode: 'manual' }]
  }));
  const saleBLots = ctx.getAllRows_('SALE_ITEM_LOTS').filter(r => r['Invoice ID'] === saleB.invoiceId);
  assert.equal(saleBLots[0]['Unit Cost'], 80, 'FIFO must consume the backdated Nov 05 @ 80 lot first');

  // Product C: Unsettled OVERSOLD sale on Nov 08 -> Backdated purchase on Nov 05 MUST BE ALLOWED & settle oversold lot cleanly
  const prodC = mustOk(ctx.addProduct(token, { name: 'Ball Valve', purchasePrice: 100, sellingPrice: 160, stock: 0, minStock: 1 }));
  const saleC = mustOk(ctx.completeSale(token, {
    customerName: 'Buyer C', customerPhone: '01722220003', paymentType: 'Cash', paymentMethod: 'Cash', discount: 0,
    date: '2026-11-08', backdatedReason: 'Oversell',
    items: [{ productId: prodC.id, name: 'Ball Valve', qty: 3, unitPrice: 160, priceMode: 'manual' }]
  }));
  advanceSeconds(5);
  mustOk(ctx.createPurchase(token, {
    supplierId: sup.id, date: '2026-11-05', backdatedReason: 'Earlier restock', discount: 0, paidAmount: 450, paymentMethod: 'Cash',
    items: [{ productId: prodC.id, name: 'Ball Valve', qty: 5, unitPrice: 90, sellingPrice: 160 }]
  }));
  assert.equal(ctx.getAllRows_('PRODUCTS').find(p => p['Product ID'] === prodC.id)['Current Stock'], 2);
  const saleCLots = ctx.getAllRows_('SALE_ITEM_LOTS').filter(r => r['Invoice ID'] === saleC.invoiceId);
  assert.equal(saleCLots[0]['Unit Cost'], 90, 'Backdated purchase must settle unsettled oversold lot at 90');

  // updatePurchase: adding Product A (whose Nov 10 lot was already sold) onto an older Nov 05 purchase MUST BE BLOCKED
  const purOld = mustOk(ctx.createPurchase(token, {
    supplierId: sup.id, date: '2026-11-05', backdatedReason: 'Old bill for B', discount: 0, paidAmount: 160, paymentMethod: 'Cash',
    items: [{ productId: prodB.id, name: 'Check Valve', qty: 2, unitPrice: 80, sellingPrice: 160 }]
  }));
  const blockedUpdate = ctx.updatePurchase(token, purOld.purchaseId, {
    supplierId: sup.id, discount: 0, paidAmount: 400, paymentMethod: 'Cash', reason: 'Add missed Gate Valve',
    items: [
      { productId: prodB.id, name: 'Check Valve', qty: 2, unitPrice: 80, sellingPrice: 160 },
      { productId: prodA.id, name: 'Gate Valve', qty: 3, unitPrice: 80, sellingPrice: 160 }
    ]
  });
  assert.equal(blockedUpdate.success, false, 'updatePurchase adding stock dated before an already-sold newer lot must be blocked');
});
