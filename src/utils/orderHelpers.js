'use strict';

const { query } = require('../config/database');

function buildOrderNumber() {
  const now = new Date();
  const ymd = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
  const rand = Math.floor(1000 + Math.random() * 9000);
  return `ORD-${ymd}-${rand}`;
}

async function recalcOrder(orderId, conn) {
  const q = conn ? (sql, p) => conn.execute(sql, p) : query;

  // 1. Get all active items
  const [items] = await q(
    'SELECT id, total_price, tax_rate FROM order_items WHERE order_id = ? AND status != ?',
    [orderId, 'cancelled']
  );
  const subtotal = items.reduce((sum, item) => sum + parseFloat(item.total_price || 0), 0);

  // 2. Get restaurant and tax settings
  const [orderRows] = await q('SELECT restaurant_id FROM orders WHERE id = ?', [orderId]);
  const restaurantId = orderRows[0]?.restaurant_id;
  let taxEnabled = true;

  if (restaurantId) {
    try {
      const [taxSettings] = await q(
        'SELECT enable_tax FROM bill_format_settings WHERE restaurant_id = ? LIMIT 1',
        [restaurantId]
      );
      if (taxSettings && taxSettings.length > 0) {
        taxEnabled = taxSettings[0].enable_tax !== 0;
      }
    } catch (err) {
      console.error('[Recalc] Tax settings error:', err.message);
    }
  }

  // 3. Process adjustments and calculate total discount
  const [adjs] = await q(
    'SELECT * FROM bill_adjustments WHERE order_id = ?',
    [orderId]
  );

  let totalDiscount = 0;
  let adjustmentTotal = 0;

  for (const adj of adjs) {
    const amt = adj.value_type === 'percentage' ? (subtotal * parseFloat(adj.value)) / 100 : parseFloat(adj.value);
    const appliedAmt = parseFloat(amt.toFixed(2));

    if (adj.adjustment_type === 'discount') {
      totalDiscount += appliedAmt;
      adjustmentTotal -= appliedAmt;
    } else {
      adjustmentTotal += appliedAmt;
    }

    await q('UPDATE bill_adjustments SET applied_amount = ? WHERE id = ?', [appliedAmt, adj.id]);
  }

  // 4. Calculate item-wise tax on discounted amount
  let totalTax = 0;
  for (const item of items) {
    let itemTax = 0;
    const itemPrice = parseFloat(item.total_price || 0);
    // Proportional discount distribution
    const itemDiscount = subtotal > 0 ? (itemPrice / subtotal) * totalDiscount : 0;
    const itemDiscountFixed = parseFloat(itemDiscount.toFixed(2));

    if (taxEnabled) {
      const taxableAmount = Math.max(0, itemPrice - itemDiscountFixed);
      itemTax = (taxableAmount * parseFloat(item.tax_rate || 0)) / 100;
      itemTax = parseFloat(itemTax.toFixed(2));
    }

    await q('UPDATE order_items SET tax_amount = ?, discount_amount = ? WHERE id = ?', [itemTax, itemDiscountFixed, item.id]);
    totalTax += itemTax;
  }

  const effectiveTax = taxEnabled ? parseFloat(totalTax.toFixed(2)) : 0;
  const totalAmount = Math.max(0, subtotal + effectiveTax + adjustmentTotal);

  // 5. Update main order record
  await q(
    'UPDATE orders SET subtotal = ?, tax_amount = ?, total_amount = ?, tax_enabled = ? WHERE id = ?',
    [subtotal, effectiveTax, totalAmount, taxEnabled ? 1 : 0, orderId]
  );

  return { subtotal, totalAmount, taxAmount: effectiveTax, taxEnabled };
}

module.exports = { buildOrderNumber, recalcOrder };
