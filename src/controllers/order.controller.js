'use strict';

const { query, transaction } = require('../config/database');
const { success, error } = require('../utils/responseHelper');
const { HTTP_STATUS, ORDER_STATUS, PAYMENT_STATUS } = require('../config/constants');
const { notifyRestaurantOwner, notifyKitchenStaff, notifyWaiters } = require('./notification.controller');
const { buildOrderNumber, recalcOrder } = require('../utils/orderHelpers');
const { generateTablePin } = require('../utils/pinHelper');
const { checkFeature } = require('../utils/featureEngine');
const { sanitizePagination } = require('../utils/validate');

/* ─── list orders ──────────────────────────────────────────────────────────── */

async function getOrders(req, res) {
  const { status, tableId, floorId, search, date, dateFrom, dateTo } = req.query;
  const { page: parsedPage, limit: parsedLimit } = sanitizePagination(req.query);
  const offset = (parsedPage - 1) * parsedLimit;

  let where = 'WHERE o.restaurant_id = ?';
  const params = [req.user.restaurantId];

  if (status) { where += ' AND o.status = ?'; params.push(status); }
  if (tableId) { where += ' AND o.table_id = ?'; params.push(tableId); }
  if (floorId) { where += ' AND t.floor_id = ?'; params.push(floorId); }
  if (search) {
    where += ' AND (o.customer_name LIKE ? OR o.customer_phone LIKE ? OR o.order_number LIKE ? OR o.bill_number LIKE ?)';
    const s = `%${search}%`;
    params.push(s, s, s, s);
  }
  if (date) {
    where += ' AND DATE(o.created_at) = ?'; params.push(date);
  } else {
    if (dateFrom) { where += ' AND DATE(o.created_at) >= ?'; params.push(dateFrom); }
    if (dateTo) { where += ' AND DATE(o.created_at) <= ?'; params.push(dateTo); }
  }

  const joinClause = `FROM orders o
     LEFT JOIN tables t ON t.id = o.table_id
     LEFT JOIN floors f ON f.id = t.floor_id
     LEFT JOIN users u ON u.id = o.waiter_id
     LEFT JOIN users c ON c.id = o.cashier_id`;

  const [countRows] = await query(`SELECT COUNT(*) AS total ${joinClause} ${where}`, params);
  const total = countRows[0].total;

  const [rows] = await query(
    `SELECT o.*, t.table_number, f.name AS floor_name,
            u.name AS waiter_name, c.name AS cashier_name,
            (SELECT SUM(amount) FROM payments WHERE order_id = o.id AND status = 'paid') AS total_collected,
            (SELECT COUNT(*) FROM order_items WHERE order_id = o.id AND status != 'cancelled') AS item_count
     ${joinClause}
     ${where}
     ORDER BY o.created_at DESC
     LIMIT ? OFFSET ?`,
    [...params, parsedLimit, offset]
  );

  return success(res, { orders: rows, total, page: parsedPage, limit: parsedLimit });
}

/* ─── get single order ─────────────────────────────────────────────────────── */

async function getOrderById(req, res) {
  const { orderId } = req.params;
  const [rows] = await query(
    `SELECT o.*, t.table_number, f.name AS floor_name,
            u.name AS waiter_name, c.name AS cashier_name
     FROM orders o
     LEFT JOIN tables t ON t.id = o.table_id
     LEFT JOIN floors f ON f.id = t.floor_id
     LEFT JOIN users u ON u.id = o.waiter_id
     LEFT JOIN users c ON c.id = o.cashier_id
     WHERE o.id = ? AND o.restaurant_id = ? LIMIT 1`,
    [orderId, req.user.restaurantId]
  );
  if (!rows || rows.length === 0) return error(res, 'Order not found.', HTTP_STATUS.NOT_FOUND);

  const [items] = await query(
    'SELECT * FROM order_items WHERE order_id = ? ORDER BY created_at ASC',
    [orderId]
  );
  const [adjustments] = await query(
    'SELECT * FROM bill_adjustments WHERE order_id = ? ORDER BY created_at ASC',
    [orderId]
  );
  const [payments] = await query(
    'SELECT * FROM payments WHERE order_id = ? ORDER BY created_at ASC',
    [orderId]
  );

  const totalPaid = payments
    .filter(p => p.status === 'paid')
    .reduce((sum, p) => sum + parseFloat(p.amount || 0), 0);

  return success(res, {
    ...rows[0],
    items,
    adjustments,
    payments,
    total_paid: totalPaid,
  });
}

async function getOrderPayments(req, res) {
  const { orderId } = req.params;
  const [payments] = await query(
    'SELECT * FROM payments WHERE order_id = ? AND restaurant_id = ? ORDER BY created_at ASC',
    [orderId, req.user.restaurantId]
  );
  return success(res, payments);
}

/* ─── create order ─────────────────────────────────────────────────────────── */

async function createOrder(req, res) {
  const { tableId, orderType, notes, customerName, customerPhone, deliveryAddress } = req.body;
  const restaurantId = req.user.restaurantId;

  // Get restaurant type
  const [restRows] = await query('SELECT type FROM restaurants WHERE id = ? LIMIT 1', [restaurantId]);
  if (!restRows || restRows.length === 0) return error(res, 'Restaurant not found.', HTTP_STATUS.NOT_FOUND);
  const restaurantType = restRows[0].type;

  const isPoss = restaurantType === 'poss';
  const effectiveOrderType = orderType || (isPoss ? 'dine_in' : 'takeaway');

  // For dine-in with table, check table availability
  let assignedWaiterId = null;
  if (tableId) {
    const [tableRows] = await query(
      'SELECT * FROM tables WHERE id = ? AND restaurant_id = ? AND is_active = 1 LIMIT 1',
      [tableId, restaurantId]
    );
    if (!tableRows || tableRows.length === 0) return error(res, 'Table not found.', HTTP_STATUS.NOT_FOUND);
    if (tableRows[0].status === 'occupied') return error(res, 'Table is already occupied.', HTTP_STATUS.CONFLICT);

    // Block if table has an active reservation in the current time window
    if (tableRows[0].status === 'reserved') {
      return error(res, 'Table is reserved for an upcoming reservation. Use "Start Order" from the reservation to seat guests.', HTTP_STATUS.CONFLICT);
    }
    const { getTableReservationConflict } = require('./reservation.controller');
    const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
    const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    const nowTime = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`;
    const conflict = await getTableReservationConflict(tableId, today, nowTime);
    if (conflict) {
      const timeStr = conflict.reservation_time?.toString().slice(0, 5);
      return error(res, `Table is blocked for a reservation at ${timeStr} (${conflict.customer_name}). The table is reserved from 1 hour before to 1.5 hours after the reservation time.`, HTTP_STATUS.CONFLICT);
    }

    assignedWaiterId = tableRows[0].assigned_waiter_id || null;
  }

  // Get floor_id from table
  let floorId = null;
  if (tableId) {
    const [tblInfo] = await query('SELECT floor_id FROM tables WHERE id = ? LIMIT 1', [tableId]);
    if (tblInfo && tblInfo.length > 0) floorId = tblInfo[0].floor_id || null;
  }

  // Use table's assigned waiter if available, otherwise fall back to current user
  const waiterId = assignedWaiterId || req.user.id;

  // Check bill limits
  const { checkLimit } = require('../utils/featureEngine');
  const [[dailyCount]] = await query('SELECT COUNT(*) AS count FROM orders WHERE restaurant_id = ? AND DATE(created_at) = CURDATE()', [restaurantId]);
  const dayCheck = await checkLimit(restaurantId, 'max_bills_per_day', dailyCount.count);
  if (!dayCheck.allowed) return error(res, `Daily bill limit reached (${dayCheck.limit}). Upgrade your plan.`, HTTP_STATUS.FORBIDDEN, { upgradeRequired: true });

  const [[monthlyCount]] = await query('SELECT COUNT(*) AS count FROM orders WHERE restaurant_id = ? AND MONTH(created_at) = MONTH(CURDATE()) AND YEAR(created_at) = YEAR(CURDATE())', [restaurantId]);
  const monthCheck = await checkLimit(restaurantId, 'max_bills_per_month', monthlyCount.count);
  if (!monthCheck.allowed) return error(res, `Monthly bill limit reached (${monthCheck.limit}). Upgrade your plan.`, HTTP_STATUS.FORBIDDEN, { upgradeRequired: true });

  const orderNumber = buildOrderNumber();
  const initialStatus = 'pending';

  const result = await transaction(async (conn) => {
    const [insertRes] = await conn.execute(
      `INSERT INTO orders (restaurant_id, table_id, floor_id, order_number, order_type, status, waiter_id, notes, customer_name, customer_phone, delivery_address)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [restaurantId, tableId || null, floorId, orderNumber, effectiveOrderType, initialStatus, waiterId, notes || null, customerName || null, customerPhone || null, effectiveOrderType === 'delivery' ? (deliveryAddress || null) : null]
    );
    const orderId = insertRes.insertId;

    // Mark table as occupied and set current_order_id
    if (tableId) {
      await conn.execute(
        'UPDATE tables SET status = ?, current_order_id = ? WHERE id = ? AND restaurant_id = ?',
        ['occupied', orderId, tableId, restaurantId]
      );
    }

    return { id: orderId, orderNumber, status: initialStatus };
  });

  // Notify restaurant owner about new order (non-blocking)
  notifyRestaurantOwner(
    restaurantId, 'info',
    `New Order: ${result.orderNumber}`,
    `A new ${effectiveOrderType.replace('_', ' ')} order has been placed.`
  ).catch(() => { });

  return success(res, result, 'Order created.', HTTP_STATUS.CREATED);
}

/* ─── add / update items ───────────────────────────────────────────────────── */

async function addOrderItems(req, res) {
  const { orderId } = req.params;
  const { items } = req.body; // [{menuItemId, variantId?, quantity, notes?}]

  if (!items || !items.length) return error(res, 'items array is required.', HTTP_STATUS.BAD_REQUEST);

  const [orderRows] = await query(
    'SELECT * FROM orders WHERE id = ? AND restaurant_id = ? LIMIT 1',
    [orderId, req.user.restaurantId]
  );
  if (!orderRows || orderRows.length === 0) return error(res, 'Order not found.', HTTP_STATUS.NOT_FOUND);
  const order = orderRows[0];
  if (['completed', 'cancelled'].includes(order.status)) return error(res, 'Cannot modify a completed/cancelled order.', HTTP_STATUS.BAD_REQUEST);

  const insertedIds = [];
  await transaction(async (conn) => {
    for (const item of items) {
      const { menuItemId, variantId, quantity, notes, addonIds } = item;
      if (!menuItemId || !quantity || quantity < 1) continue;

      // Fetch item details
      let itemName, itemPrice, taxRate;
      if (variantId) {
        const [vRows] = await conn.execute(
          `SELECT mi.name AS item_name, mi.tax_rate, mv.name AS variant_name, mv.price
           FROM menu_item_variants mv JOIN menu_items mi ON mi.id = mv.menu_item_id
           WHERE mv.id = ? AND mi.id = ? AND mi.restaurant_id = ? LIMIT 1`,
          [variantId, menuItemId, req.user.restaurantId]
        );
        if (!vRows || vRows.length === 0) continue;
        itemName = `${vRows[0].item_name} (${vRows[0].variant_name})`;
        itemPrice = parseFloat(vRows[0].price);
        taxRate = parseFloat(vRows[0].tax_rate || 0);
      } else {
        const [iRows] = await conn.execute(
          'SELECT name, price, tax_rate FROM menu_items WHERE id = ? AND restaurant_id = ? LIMIT 1',
          [menuItemId, req.user.restaurantId]
        );
        if (!iRows || iRows.length === 0) continue;
        itemName = iRows[0].name;
        itemPrice = parseFloat(iRows[0].price);
        taxRate = parseFloat(iRows[0].tax_rate || 0);
      }

      // Fetch selected addons
      let addonDetails = null;
      let addonPerUnit = 0;
      if (addonIds && addonIds.length > 0) {
        const phAddon = addonIds.map(() => '?').join(',');
        const [addonRows] = await conn.execute(
          `SELECT id, name, price FROM menu_item_addons WHERE id IN (${phAddon}) AND menu_item_id = ? AND is_available = 1`,
          [...addonIds, menuItemId]
        );
        if (addonRows && addonRows.length > 0) {
          addonDetails = addonRows.map(a => ({ name: a.name, price: parseFloat(a.price) }));
          addonPerUnit = addonDetails.reduce((sum, a) => sum + a.price, 0);
        }
      }

      const effectiveUnitPrice = itemPrice + addonPerUnit;
      const totalPrice = effectiveUnitPrice * quantity;
      const taxAmount = (totalPrice * taxRate) / 100;

      const [insRes] = await conn.execute(
        `INSERT INTO order_items (order_id, restaurant_id, menu_item_id, variant_id, item_name, item_price, quantity, tax_rate, tax_amount, total_price, notes, addon_details, addon_per_unit)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [orderId, req.user.restaurantId, menuItemId, variantId || null, itemName, itemPrice, quantity, taxRate, taxAmount, totalPrice, notes || null, addonDetails ? JSON.stringify(addonDetails) : null, addonPerUnit]
      );
      insertedIds.push(insRes.insertId);
    }

    await recalcOrder(orderId, conn);
  });

  return success(res, { insertedIds }, 'Items added.', HTTP_STATUS.CREATED);
}

async function updateOrderItem(req, res) {
  const { orderId, itemId } = req.params;
  const { quantity, notes, status } = req.body;

  const [orderRows] = await query(
    'SELECT status FROM orders WHERE id = ? AND restaurant_id = ? LIMIT 1',
    [orderId, req.user.restaurantId]
  );
  if (!orderRows || orderRows.length === 0) return error(res, 'Order not found.', HTTP_STATUS.NOT_FOUND);
  if (['completed', 'cancelled'].includes(orderRows[0].status)) return error(res, 'Cannot modify a completed/cancelled order.', HTTP_STATUS.BAD_REQUEST);

  const [itemRows] = await query('SELECT * FROM order_items WHERE id = ? AND order_id = ? LIMIT 1', [itemId, orderId]);
  if (!itemRows || itemRows.length === 0) return error(res, 'Item not found.', HTTP_STATUS.NOT_FOUND);

  const updates = {};
  if (quantity !== undefined && quantity > 0) {
    updates.quantity = quantity;
    const addonPerUnit = parseFloat(itemRows[0].addon_per_unit || 0);
    updates.total_price = (parseFloat(itemRows[0].item_price) + addonPerUnit) * quantity;
    updates.tax_amount = (updates.total_price * parseFloat(itemRows[0].tax_rate || 0)) / 100;
  }
  if (notes !== undefined) updates.notes = notes;
  if (status !== undefined) updates.status = status;

  if (Object.keys(updates).length) {
    const setClauses = Object.keys(updates).map(k => `${k} = ?`).join(', ');
    await query(`UPDATE order_items SET ${setClauses} WHERE id = ?`, [...Object.values(updates), itemId]);
    await recalcOrder(orderId);
  }

  return success(res, null, 'Item updated.');
}

async function removeOrderItem(req, res) {
  const { orderId, itemId } = req.params;
  const [orderRows] = await query(
    'SELECT status FROM orders WHERE id = ? AND restaurant_id = ? LIMIT 1',
    [orderId, req.user.restaurantId]
  );
  if (!orderRows || orderRows.length === 0) return error(res, 'Order not found.', HTTP_STATUS.NOT_FOUND);
  if (['completed', 'cancelled'].includes(orderRows[0].status)) return error(res, 'Cannot modify a completed/cancelled order.', HTTP_STATUS.BAD_REQUEST);

  await query('DELETE FROM order_items WHERE id = ? AND order_id = ?', [itemId, orderId]);
  await recalcOrder(orderId);
  return success(res, null, 'Item removed.');
}

/* ─── send KOT ─────────────────────────────────────────────────────────────── */

async function sendKOT(req, res) {
  const { orderId } = req.params;
  const [orderRows] = await query(
    'SELECT * FROM orders WHERE id = ? AND restaurant_id = ? LIMIT 1',
    [orderId, req.user.restaurantId]
  );
  if (!orderRows || orderRows.length === 0) return error(res, 'Order not found.', HTTP_STATUS.NOT_FOUND);

  const [pendingItems] = await query(
    "SELECT * FROM order_items WHERE order_id = ? AND status = 'pending' AND kot_sent = 0",
    [orderId]
  );
  if (!pendingItems || pendingItems.length === 0) return error(res, 'No new items to send to kitchen.', HTTP_STATUS.BAD_REQUEST);

  await transaction(async (conn) => {
    // Mark items as sent to kitchen but leave status as 'pending' — kitchen will advance
    await conn.execute(
      "UPDATE order_items SET kot_sent = 1 WHERE order_id = ? AND status = 'pending' AND kot_sent = 0",
      [orderId]
    );
    await conn.execute("UPDATE orders SET status = 'preparing', kot_printed = 1 WHERE id = ? AND status IN ('pending', 'pending_payment', 'confirmed')", [orderId]);
  });

  const [updatedOrder] = await query(
    "SELECT o.order_number, o.order_type, t.table_number, f.name AS floor_name FROM orders o LEFT JOIN tables t ON t.id = o.table_id LEFT JOIN floors f ON f.id = t.floor_id WHERE o.id = ?",
    [orderId]
  );

  const [rawKotItems] = await query(
    "SELECT item_name, quantity, notes, addon_details FROM order_items WHERE order_id = ? AND kot_sent = 1 AND status = 'pending'",
    [orderId]
  );

  // Merge duplicate items (same name + addons + notes) for KOT display
  const kotMap = new Map();
  for (const item of rawKotItems) {
    const addonSig = item.addon_details ? JSON.stringify(item.addon_details) : 'none';
    const key = `${item.item_name}_${addonSig}_${item.notes || ''}`;
    if (kotMap.has(key)) {
      kotMap.get(key).quantity += item.quantity;
    } else {
      kotMap.set(key, { ...item });
    }
  }
  const items = Array.from(kotMap.values());

  // Notify kitchen staff about new KOT (non-blocking)
  const tableInfo = updatedOrder[0].table_number ? ` (Table ${updatedOrder[0].table_number})` : '';
  notifyKitchenStaff(
    req.user.restaurantId,
    `New KOT: #${updatedOrder[0].order_number}`,
    `${pendingItems.length} item(s) sent to kitchen${tableInfo}`
  ).catch(() => {});

  return success(res, {
    itemsSent: pendingItems.length,
    order_number: updatedOrder[0].order_number,
    order_type: updatedOrder[0].order_type,
    table_number: updatedOrder[0].table_number,
    floor_name: updatedOrder[0].floor_name,
    items
  }, 'KOT sent to kitchen.');
}

/* ─── bill adjustments ─────────────────────────────────────────────────────── */

async function addBillAdjustment(req, res) {
  const { orderId } = req.params;
  const { label, type, value, isPercentage } = req.body;

  if (!label || !type || value === undefined) return error(res, 'label, type and value are required.', HTTP_STATUS.BAD_REQUEST);
  const validTypes = ['discount', 'charge', 'tax'];
  if (!validTypes.includes(type)) return error(res, 'Invalid adjustment type.', HTTP_STATUS.BAD_REQUEST);

  const [orderRows] = await query(
    'SELECT status, subtotal FROM orders WHERE id = ? AND restaurant_id = ? LIMIT 1',
    [orderId, req.user.restaurantId]
  );
  if (!orderRows || orderRows.length === 0) return error(res, 'Order not found.', HTTP_STATUS.NOT_FOUND);
  if (orderRows[0].status === 'completed') return error(res, 'Cannot modify a completed/paid order.', HTTP_STATUS.BAD_REQUEST);

  const [countRows] = await query('SELECT COUNT(*) AS count FROM bill_adjustments WHERE order_id = ?', [orderId]);
  if (countRows[0].count >= 5) return error(res, 'Maximum 5 adjustments per bill allowed.', HTTP_STATUS.BAD_REQUEST);

  const subtotalVal = parseFloat(orderRows[0].subtotal || 0);
  const parsedValue = parseFloat(value);
  const appliedAmount = isPercentage ? (subtotalVal * parsedValue) / 100 : parsedValue;
  const valueType = isPercentage ? 'percentage' : 'fixed';

  await transaction(async (conn) => {
    await conn.execute(
      'INSERT INTO bill_adjustments (order_id, restaurant_id, label, adjustment_type, value_type, value, applied_amount) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [orderId, req.user.restaurantId, label, type, valueType, parsedValue, parseFloat(Math.abs(appliedAmount).toFixed(2))]
    );
    await recalcOrder(orderId, conn);
  });

  return success(res, null, 'Adjustment added.');
}

async function removeBillAdjustment(req, res) {
  const { orderId, adjustmentId } = req.params;
  const [orderRows] = await query(
    'SELECT status FROM orders WHERE id = ? AND restaurant_id = ? LIMIT 1',
    [orderId, req.user.restaurantId]
  );
  if (!orderRows || orderRows.length === 0) return error(res, 'Order not found.', HTTP_STATUS.NOT_FOUND);
  if (orderRows[0].status === 'completed') return error(res, 'Cannot modify a completed/paid order.', HTTP_STATUS.BAD_REQUEST);

  await query('DELETE FROM bill_adjustments WHERE id = ? AND order_id = ?', [adjustmentId, orderId]);
  await recalcOrder(orderId);
  return success(res, null, 'Adjustment removed.');
}

/* ─── mark paid (cash / manual) ────────────────────────────────────────────── */

async function addOrderPayment(req, res) {
  const { orderId } = req.params;
  const { payments, paymentMode, amount, amountReceived, notes } = req.body;

  // Normalize to an array of payments
  let paymentsToProcess = [];
  if (Array.isArray(payments)) {
    paymentsToProcess = payments;
  } else if (paymentMode && amount) {
    paymentsToProcess = [{ paymentMode, amount, amountReceived: amountReceived || amount, notes }];
  }

  if (paymentsToProcess.length === 0) {
    return error(res, 'At least one payment record is required.', HTTP_STATUS.BAD_REQUEST);
  }

  const validModes = ['cash', 'card', 'upi', 'online'];
  for (const p of paymentsToProcess) {
    if (!p.paymentMode || !validModes.includes(p.paymentMode)) {
      return error(res, `Invalid payment mode: ${p.paymentMode}`, HTTP_STATUS.BAD_REQUEST);
    }
    if (!p.amount || p.amount <= 0) {
      return error(res, `Invalid amount: ${p.amount}`, HTTP_STATUS.BAD_REQUEST);
    }
  }

  const [orderRows] = await query(
    'SELECT * FROM orders WHERE id = ? AND restaurant_id = ? LIMIT 1',
    [orderId, req.user.restaurantId]
  );
  if (!orderRows || orderRows.length === 0) return error(res, 'Order not found.', HTTP_STATUS.NOT_FOUND);
  const order = orderRows[0];
  if (order.payment_status === 'paid') return error(res, 'Order already fully paid.', HTTP_STATUS.BAD_REQUEST);

  await transaction(async (conn) => {
    // 1. Insert payment records
    for (const p of paymentsToProcess) {
      await conn.execute(
        `INSERT INTO payments (order_id, restaurant_id, amount, amount_received, payment_mode, status, processed_by, notes)
         VALUES (?, ?, ?, ?, ?, 'paid', ?, ?)`,
        [orderId, req.user.restaurantId, p.amount, p.amountReceived || p.amount, p.paymentMode, req.user.id, p.notes || null]
      );
    }

    // 2. Get total paid so far
    const [payRows] = await conn.execute(
      "SELECT SUM(amount) AS total_paid FROM payments WHERE order_id = ? AND status = 'paid'",
      [orderId]
    );
    const totalPaid = parseFloat(payRows[0].total_paid || 0);

    // 3. Update order status
    let paymentStatus = 'partial';
    let orderStatus = order.status;
    let paymentModeField = order.payment_mode;

    if (totalPaid >= parseFloat(order.total_amount)) {
      paymentStatus = 'paid';
      orderStatus = 'completed';
    }

    // Determine integrated payment mode
    const [modesRows] = await conn.execute(
      "SELECT DISTINCT payment_mode FROM payments WHERE order_id = ? AND status = 'paid'",
      [orderId]
    );
    if (modesRows.length > 1) {
      paymentModeField = 'mixed';
    } else if (modesRows.length === 1) {
      paymentModeField = modesRows[0].payment_mode;
    }

    // Generate bill number when fully paid
    let billNumber = order.bill_number;
    if (paymentStatus === 'paid' && !billNumber) {
      const [restRows] = await conn.execute(
        'SELECT bill_prefix, bill_counter FROM restaurants WHERE id = ? FOR UPDATE',
        [order.restaurant_id]
      );
      const prefix = (restRows[0]?.bill_prefix || 'INV').toUpperCase();
      const newCounter = (restRows[0]?.bill_counter || 0) + 1;
      billNumber = `${prefix}-${String(newCounter).padStart(5, '0')}`;
      await conn.execute(
        'UPDATE restaurants SET bill_counter = ? WHERE id = ?',
        [newCounter, order.restaurant_id]
      );
    }

    await conn.execute(
      `UPDATE orders SET status = ?, payment_status = ?, payment_mode = ?, cashier_id = ?,
       completed_at = CASE WHEN ? = 'paid' THEN NOW() ELSE completed_at END,
       bill_number = COALESCE(bill_number, ?), bill_generated = CASE WHEN ? = 'paid' THEN 1 ELSE bill_generated END,
       billed_at = CASE WHEN ? = 'paid' AND billed_at IS NULL THEN NOW() ELSE billed_at END
       WHERE id = ?`,
      [orderStatus, paymentStatus, paymentModeField, req.user.id, paymentStatus, billNumber, paymentStatus, paymentStatus, orderId]
    );

    // 4. Free table if fully paid -> move to cleaning, reset PIN, deactivate sessions
    if (paymentStatus === 'paid' && order.table_id) {
      const edineOn = await checkFeature(order.restaurant_id, 'feature_edine_in_orders');
      const newPin = edineOn ? generateTablePin() : null;
      await conn.execute(
        "UPDATE tables SET status = 'cleaning', current_order_id = NULL, table_pin = ? WHERE id = ?",
        [newPin, order.table_id]
      );
      await conn.execute(
        'UPDATE qr_sessions SET is_active = 0 WHERE table_id = ? AND restaurant_id = ? AND is_active = 1',
        [order.table_id, order.restaurant_id]
      );
    }

    // 5. Auto-complete linked reservation
    if (paymentStatus === 'paid') {
      await conn.execute(
        "UPDATE reservations SET status = 'completed' WHERE order_id = ? AND restaurant_id = ? AND status NOT IN ('completed', 'cancelled', 'no_show')",
        [orderId, order.restaurant_id]
      );
    }
  });

  return success(res, null, 'Payment(s) recorded.');
}

async function markOrderPaid(req, res) {
  // Legacy support - redirect to addOrderPayment logic with full amount
  req.body.amount = 999999; // placeholder for full payment
  return addOrderPayment(req, res);
}

/* ─── close order (without payment) ────────────────────────────────────────── */

async function closeOrder(req, res) {
  const { orderId } = req.params;
  const [orderRows] = await query(
    'SELECT * FROM orders WHERE id = ? AND restaurant_id = ? LIMIT 1',
    [orderId, req.user.restaurantId]
  );
  if (!orderRows || orderRows.length === 0) return error(res, 'Order not found.', HTTP_STATUS.NOT_FOUND);
  const order = orderRows[0];
  if (order.payment_status === 'paid') return error(res, 'Order is already paid.', HTTP_STATUS.BAD_REQUEST);
  if (order.status === 'cancelled') return error(res, 'Order is already cancelled.', HTTP_STATUS.BAD_REQUEST);

  await transaction(async (conn) => {
    await conn.execute("UPDATE orders SET status = 'completed', completed_at = NOW() WHERE id = ?", [orderId]);
    if (order.table_id) {
      const edineOn = await checkFeature(req.user.restaurantId, 'feature_edine_in_orders');
      const newPin = edineOn ? generateTablePin() : null;
      await conn.execute(
        "UPDATE tables SET status = 'available', current_order_id = NULL, table_pin = ? WHERE id = ? AND restaurant_id = ?",
        [newPin, order.table_id, req.user.restaurantId]
      );
      await conn.execute(
        'UPDATE qr_sessions SET is_active = 0 WHERE table_id = ? AND restaurant_id = ? AND is_active = 1',
        [order.table_id, req.user.restaurantId]
      );
    }
    // Auto-complete linked reservation
    await conn.execute(
      "UPDATE reservations SET status = 'completed' WHERE order_id = ? AND restaurant_id = ? AND status NOT IN ('completed', 'cancelled', 'no_show')",
      [orderId, req.user.restaurantId]
    );
  });

  return success(res, null, 'Order closed.');
}

/* ─── reopen order ──────────────────────────────────────────────────────────── */

async function reopenOrder(req, res) {
  const { orderId } = req.params;
  const [orderRows] = await query(
    'SELECT * FROM orders WHERE id = ? AND restaurant_id = ? LIMIT 1',
    [orderId, req.user.restaurantId]
  );
  if (!orderRows || orderRows.length === 0) return error(res, 'Order not found.', HTTP_STATUS.NOT_FOUND);
  const order = orderRows[0];
  if (order.payment_status === 'paid') return error(res, 'Cannot reopen a paid order.', HTTP_STATUS.BAD_REQUEST);
  if (order.status !== 'completed') return error(res, 'Only closed orders can be reopened.', HTTP_STATUS.BAD_REQUEST);

  await transaction(async (conn) => {
    await conn.execute("UPDATE orders SET status = 'preparing', completed_at = NULL WHERE id = ?", [orderId]);
    if (order.table_id) {
      await conn.execute(
        "UPDATE tables SET status = 'occupied', current_order_id = ? WHERE id = ? AND restaurant_id = ?",
        [orderId, order.table_id, req.user.restaurantId]
      );
    }
  });

  return success(res, null, 'Order reopened.');
}

/* ─── cancel order ─────────────────────────────────────────────────────────── */

async function cancelOrder(req, res) {
  const { orderId } = req.params;
  const { reason } = req.body;
  const [orderRows] = await query(
    'SELECT * FROM orders WHERE id = ? AND restaurant_id = ? LIMIT 1',
    [orderId, req.user.restaurantId]
  );
  if (!orderRows || orderRows.length === 0) return error(res, 'Order not found.', HTTP_STATUS.NOT_FOUND);
  const order = orderRows[0];
  if (order.payment_status === 'paid') return error(res, 'Cannot cancel a paid order.', HTTP_STATUS.BAD_REQUEST);
  if (order.status === 'cancelled') return error(res, 'Order already cancelled.', HTTP_STATUS.BAD_REQUEST);

  await transaction(async (conn) => {
    await conn.execute(
      "UPDATE orders SET status = 'cancelled', notes = CONCAT(COALESCE(notes, ''), ?) WHERE id = ?",
      [reason ? ` | Cancelled: ${reason}` : ' | Cancelled', orderId]
    );
    if (order.table_id) {
      const edineOn = await checkFeature(req.user.restaurantId, 'feature_edine_in_orders');
      const newPin = edineOn ? generateTablePin() : null;
      await conn.execute(
        "UPDATE tables SET status = 'available', current_order_id = NULL, table_pin = ? WHERE id = ? AND restaurant_id = ?",
        [newPin, order.table_id, req.user.restaurantId]
      );
      await conn.execute(
        'UPDATE qr_sessions SET is_active = 0 WHERE table_id = ? AND restaurant_id = ? AND is_active = 1',
        [order.table_id, req.user.restaurantId]
      );
    }
    // Auto-cancel linked reservation
    await conn.execute(
      "UPDATE reservations SET status = 'cancelled' WHERE order_id = ? AND restaurant_id = ? AND status NOT IN ('completed', 'cancelled', 'no_show')",
      [orderId, req.user.restaurantId]
    );
  });

  return success(res, null, 'Order cancelled.');
}

/* ─── kitchen display ──────────────────────────────────────────────────────── */

async function getKitchenOrders(req, res) {
  // Fetch active orders (no aggregation — works on all MySQL/MariaDB versions)
  const [orders] = await query(
    `SELECT o.id, o.order_number, o.order_type, o.created_at,
            t.table_number, f.name AS floor_name
     FROM orders o
     LEFT JOIN tables t ON t.id = o.table_id
     LEFT JOIN floors f ON f.id = t.floor_id
     WHERE o.restaurant_id = ? AND o.status NOT IN ('completed', 'cancelled')
     ORDER BY o.created_at ASC`,
    [req.user.restaurantId]
  );
  if (!orders || orders.length === 0) return success(res, []);

  // Fetch items sent to kitchen (pending/preparing/ready) in one query
  const orderIds = orders.map(o => o.id);
  const placeholders = orderIds.map(() => '?').join(',');
  const [items] = await query(
    `SELECT oi.id, oi.order_id, oi.item_name, oi.quantity, oi.notes, oi.status,
            oi.addon_details, mi.preparation_time
     FROM order_items oi
     LEFT JOIN menu_items mi ON mi.id = oi.menu_item_id
     WHERE oi.order_id IN (${placeholders}) AND oi.kot_sent = 1 AND oi.status IN ('pending', 'preparing', 'ready')
     ORDER BY oi.created_at ASC`,
    orderIds
  );

  // Group items by order and filter out orders with no pending items
  const itemMap = {};
  for (const item of items) {
    if (!itemMap[item.order_id]) itemMap[item.order_id] = [];
    itemMap[item.order_id].push(item);
  }
  const result = orders
    .map(o => ({ ...o, items: itemMap[o.id] || [] }))
    .filter(o => o.items.length > 0);

  return success(res, result);
}

async function updateKitchenItemStatus(req, res) {
  const { itemId } = req.params;
  const { status } = req.body;
  const validStatuses = ['pending', 'preparing', 'ready', 'served'];
  if (!validStatuses.includes(status)) return error(res, 'Invalid kitchen item status.', HTTP_STATUS.BAD_REQUEST);

  const [rows] = await query(
    `SELECT oi.*, o.restaurant_id, o.status AS order_status FROM order_items oi
     JOIN orders o ON o.id = oi.order_id
     WHERE oi.id = ? LIMIT 1`,
    [itemId]
  );
  if (!rows || rows.length === 0) return error(res, 'Item not found.', HTTP_STATUS.NOT_FOUND);
  if (rows[0].restaurant_id !== req.user.restaurantId) return error(res, 'Forbidden.', HTTP_STATUS.FORBIDDEN);

  await transaction(async (conn) => {
    await conn.execute('UPDATE order_items SET status = ? WHERE id = ?', [status, itemId]);

    const orderId = rows[0].order_id;

    // Auto-update order status based on item statuses
    const [updatedItems] = await conn.execute(
      "SELECT status FROM order_items WHERE order_id = ? AND status != 'cancelled'",
      [orderId]
    );
    const itemStatuses = updatedItems.map(i => i.status);

    if (itemStatuses.length > 0) {
      const allServed = itemStatuses.every(s => s === 'served');
      const allReadyOrServed = itemStatuses.every(s => s === 'ready' || s === 'served');

      if (allServed) {
        await conn.execute("UPDATE orders SET status = 'ready' WHERE id = ? AND status NOT IN ('completed', 'cancelled')", [orderId]);
      } else if (allReadyOrServed) {
        await conn.execute("UPDATE orders SET status = 'ready' WHERE id = ? AND status IN ('pending', 'confirmed', 'preparing')", [orderId]);
      }

      // Notify waiters & admins when all items are ready
      if (allReadyOrServed) {
        const [orderInfo] = await conn.execute('SELECT order_number, table_id FROM orders WHERE id = ?', [orderId]);
        const orderNum = orderInfo[0]?.order_number || orderId;
        const tableRef = orderInfo[0]?.table_id ? ` is ready for serving` : ' is ready';
        notifyWaiters(req.user.restaurantId, `Order #${orderNum} Ready`, `Order #${orderNum}${tableRef}`).catch(() => {});
        notifyRestaurantOwner(req.user.restaurantId, 'order', `Order #${orderNum} Ready`, `All items in order #${orderNum} are ready.`).catch(() => {});
      }
    }
  });

  return success(res, null, 'Item status updated.');
}

/* ─── generate bill (preview) ──────────────────────────────────────────────── */

async function generateBill(req, res) {
  const { orderId } = req.params;

  // 0. Refresh totals if order is active (so tax setting changes reflect immediately)
  const [initialRows] = await query('SELECT status FROM orders WHERE id = ?', [orderId]);
  const status = initialRows[0]?.status;
  if (status && !['completed', 'cancelled'].includes(status)) {
    await recalcOrder(orderId);
  }

  // Assign a bill number if not yet assigned
  const [preCheck] = await query('SELECT bill_number FROM orders WHERE id = ? AND restaurant_id = ? LIMIT 1', [orderId, req.user.restaurantId]);
  if (preCheck && preCheck.length > 0 && !preCheck[0].bill_number) {
    await transaction(async (conn) => {
      const [restRows] = await conn.execute(
        'SELECT bill_prefix, bill_counter FROM restaurants WHERE id = ? FOR UPDATE',
        [req.user.restaurantId]
      );
      const prefix = (restRows[0]?.bill_prefix || 'INV').toUpperCase();
      const newCounter = (restRows[0]?.bill_counter || 0) + 1;
      const billNum = `${prefix}-${String(newCounter).padStart(5, '0')}`;
      await conn.execute('UPDATE restaurants SET bill_counter = ? WHERE id = ?', [newCounter, req.user.restaurantId]);
      await conn.execute('UPDATE orders SET bill_number = ?, bill_generated = 1, billed_at = NOW() WHERE id = ?', [billNum, orderId]);
    });
  }

  const [rows] = await query(
    `SELECT o.*, t.table_number, f.name AS floor_name,
            u.name AS waiter_name, u.role AS waiter_role, r.name AS restaurant_name,
            r.address, r.phone, r.gstin, r.logo_url
     FROM orders o
     LEFT JOIN tables t ON t.id = o.table_id
     LEFT JOIN floors f ON f.id = t.floor_id
     LEFT JOIN users u ON u.id = o.waiter_id
     LEFT JOIN restaurants r ON r.id = o.restaurant_id
     WHERE o.id = ? AND o.restaurant_id = ? LIMIT 1`,
    [orderId, req.user.restaurantId]
  );
  if (!rows || rows.length === 0) return error(res, 'Order not found.', HTTP_STATUS.NOT_FOUND);
  const o = rows[0];

  const [rawItems] = await query(
    "SELECT * FROM order_items WHERE order_id = ? AND status != 'cancelled' ORDER BY created_at ASC",
    [orderId]
  );

  // Merge duplicate items (same menu_item_id + variant_id + same addons) across KOTs
  const mergedMap = new Map();
  let grandTotalTax = 0;

  for (const item of rawItems) {
    // Include addon signature in merge key so items with different addons stay separate
    const addonSig = item.addon_details ? JSON.stringify(item.addon_details) : 'none';
    const key = `${item.menu_item_id || 'null'}_${item.variant_id || 'null'}_${addonSig}`;
    const itemTax = o.tax_enabled ? parseFloat(item.tax_amount || 0) : 0;
    grandTotalTax += itemTax;
    const lineTotal = parseFloat(item.total_price || 0) - parseFloat(item.discount_amount || 0) + itemTax;

    if (mergedMap.has(key)) {
      const existing = mergedMap.get(key);
      existing.quantity += item.quantity;
      existing.total_price = parseFloat(existing.total_price) + parseFloat(item.total_price);
      existing.tax_amount = parseFloat(existing.tax_amount) + parseFloat(item.tax_amount);
      existing.discount_amount = parseFloat(existing.discount_amount || 0) + parseFloat(item.discount_amount || 0);
      existing.line_total = parseFloat(existing.line_total || 0) + lineTotal;
    } else {
      mergedMap.set(key, { ...item, line_total: lineTotal });
    }
  }
  const items = Array.from(mergedMap.values());

  const [adjustments] = await query(
    'SELECT * FROM bill_adjustments WHERE order_id = ? ORDER BY created_at ASC',
    [orderId]
  );
  const [billFormat] = await query(
    'SELECT * FROM bill_format_settings WHERE restaurant_id = ? LIMIT 1',
    [req.user.restaurantId]
  );

  // Aggregate taxes into single CGST/SGST lines
  const taxBreakdown = [];
  if (o.tax_enabled && grandTotalTax > 0) {
    const halfAmount = parseFloat((grandTotalTax / 2).toFixed(2));
    taxBreakdown.push({ label: 'CGST', rate: null, taxAmount: halfAmount });
    taxBreakdown.push({ label: 'SGST', rate: null, taxAmount: halfAmount });
  }

  const bf = billFormat[0] || {};
  const enableTax = o.tax_enabled !== 0;

  return success(res, {
    order: o,
    items,
    adjustments,
    billFormat: bf,
    taxBreakdown,
    enableTax,
  });
}

async function updateOrderCustomer(req, res) {
  const { orderId } = req.params;
  const { customerName, customerPhone, deliveryAddress } = req.body;

  try {
    await query(
      'UPDATE orders SET customer_name = ?, customer_phone = ?, delivery_address = ? WHERE id = ? AND restaurant_id = ?',
      [customerName || null, customerPhone || null, deliveryAddress !== undefined ? (deliveryAddress || null) : null, orderId, req.user.restaurantId]
    );

    return success(res, null, 'Customer details updated.');
  } catch (err) {
    console.error('[updateOrderCustomer] Error:', err);
    return error(res, 'Failed to update customer: ' + err.message, HTTP_STATUS.SERVER_ERROR);
  }
}

async function getCustomerByPhone(req, res) {
  try {
    const { phone } = req.params;
    const { restaurantId } = req.user;

    if (!phone) {
      return error(res, 'Phone number is required', HTTP_STATUS.BAD_REQUEST);
    }

    const [rows] = await query(
      'SELECT customer_name FROM orders WHERE restaurant_id = ? AND customer_phone = ? AND customer_name IS NOT NULL AND customer_name != "" ORDER BY created_at DESC LIMIT 1',
      [restaurantId, phone]
    );

    if (rows && rows.length > 0) {
      return success(res, rows[0]);
    }

    return success(res, { customer_name: null });
  } catch (err) {
    console.error('[GetCustomerByPhone] Error:', err.message);
    return error(res, 'Failed to fetch customer details', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
}

/* ─── CRM: customer list with aggregates ──────────────────────────────────── */

async function getCustomers(req, res) {
  const { page, limit, search, dateFrom, dateTo } = req.query;
  const restaurantId = req.user.restaurantId;
  const parsedPage = parseInt(page, 10) || 1;
  const parsedLimit = parseInt(limit, 10) || 20;
  const offset = (parsedPage - 1) * parsedLimit;

  let where = 'WHERE o.restaurant_id = ? AND (o.customer_phone IS NOT NULL AND o.customer_phone != "")';
  const params = [restaurantId];

  if (search) {
    where += ' AND (o.customer_name LIKE ? OR o.customer_phone LIKE ?)';
    const s = `%${search}%`;
    params.push(s, s);
  }

  let having = '';
  const havingParams = [];
  if (dateFrom) { having += ' AND last_visit >= ?'; havingParams.push(dateFrom); }
  if (dateTo) { having += ' AND last_visit <= ?'; havingParams.push(dateTo + ' 23:59:59'); }
  if (having) having = 'HAVING 1=1' + having;

  const innerQuery = `SELECT o.customer_phone,
      MAX(o.customer_name) AS customer_name,
      MAX(o.created_at) AS last_visit,
      COUNT(o.id) AS total_orders,
      SUM(o.total_amount) AS total_spent
    FROM orders o
    ${where}
    GROUP BY o.customer_phone
    ${having}`;

  const [countRows] = await query(
    `SELECT COUNT(*) AS total FROM (${innerQuery}) AS sub`,
    [...params, ...havingParams]
  );
  const total = countRows[0]?.total || 0;

  const [rows] = await query(
    `${innerQuery} ORDER BY last_visit DESC LIMIT ? OFFSET ?`,
    [...params, ...havingParams, parsedLimit, offset]
  );

  return success(res, { customers: rows, total, page: parsedPage });
}

/* ─── CRM: customer order history ─────────────────────────────────────────── */

async function getCustomerOrders(req, res) {
  const { phone } = req.params;
  const { page, limit } = req.query;
  const parsedPage = parseInt(page, 10) || 1;
  const parsedLimit = parseInt(limit, 10) || 20;
  const restaurantId = req.user.restaurantId;
  const offset = (parsedPage - 1) * parsedLimit;

  const [countRows] = await query(
    'SELECT COUNT(*) AS total FROM orders WHERE restaurant_id = ? AND customer_phone = ?',
    [restaurantId, phone]
  );

  const [rows] = await query(
    `SELECT o.id, o.order_number, o.order_type, o.status, o.payment_status, o.payment_mode,
            o.total_amount, o.customer_name, o.created_at, o.completed_at,
            t.table_number, f.name AS floor_name
     FROM orders o
     LEFT JOIN tables t ON t.id = o.table_id
     LEFT JOIN floors f ON f.id = t.floor_id
     WHERE o.restaurant_id = ? AND o.customer_phone = ?
     ORDER BY o.created_at DESC
     LIMIT ? OFFSET ?`,
    [restaurantId, phone, parsedLimit, offset]
  );

  return success(res, { orders: rows, total: countRows[0].total, page: parsedPage });
}

/* ─── E-Bill ─────────────────────────────────────────────────────────────── */

const { sendWhatsAppInvoice, sendWhatsAppReview, sendWhatsAppInvoiceReview } = require('../utils/whatsappOtp');
const crypto = require('crypto');

/**
 * POST /orders/:orderId/send-ebill  (authenticated)
 * Generates the bill (if not already), sends e-bill link via WhatsApp.
 */
async function sendEBill(req, res) {
  try {
    const { orderId } = req.params;
    const restaurantId = req.user.restaurantId;

    // Fetch restaurant info including WA mode
    const [restRows] = await query(
      'SELECT wa_tokens, wa_messaging_mode, google_review_url FROM restaurants WHERE id = ? LIMIT 1',
      [restaurantId]
    );
    if (!restRows || !restRows[0]) return error(res, 'Restaurant not found.', HTTP_STATUS.NOT_FOUND);

    const waMode = restRows[0].wa_messaging_mode || 1;
    const googleReviewUrl = restRows[0].google_review_url;

    // Determine token cost based on mode
    const tokenCost = waMode === 1 ? 1 : waMode === 2 ? 3.5 : 4.5;

    // Check WA token balance
    if (!restRows[0].wa_tokens || restRows[0].wa_tokens < tokenCost) {
      return error(res, 'Insufficient WA messaging tokens in your account. Please recharge the tokens.', HTTP_STATUS.BAD_REQUEST);
    }

    // Validate Google Review URL for modes 2 & 3
    if (waMode > 1 && !googleReviewUrl) {
      return error(res, 'Google Maps Review URL not configured. Update it in Settings > WA Messaging.', HTTP_STATUS.BAD_REQUEST);
    }

    // Fetch order with restaurant info
    const [rows] = await query(
      `SELECT o.id, o.order_number, o.customer_name, o.customer_phone, o.total_amount,
              o.bill_number, o.ebill_token, r.name AS restaurant_name
       FROM orders o JOIN restaurants r ON r.id = o.restaurant_id
       WHERE o.id = ? AND o.restaurant_id = ? LIMIT 1`,
      [orderId, restaurantId]
    );
    if (!rows || rows.length === 0) return error(res, 'Order not found.', HTTP_STATUS.NOT_FOUND);
    const order = rows[0];

    if (!order.customer_phone || order.customer_phone.replace(/\D/g, '').length < 10) {
      return error(res, 'Valid customer phone number is required.', HTTP_STATUS.BAD_REQUEST);
    }

    // Generate unique e-bill token if not already set
    let ebillToken = order.ebill_token;
    if (!ebillToken) {
      ebillToken = crypto.randomBytes(16).toString('hex');
      await query('UPDATE orders SET ebill_token = ? WHERE id = ?', [ebillToken, orderId]);
    }

    // Generate bill number if not yet assigned (reuse generateBill logic)
    if (!order.bill_number) {
      await transaction(async (conn) => {
        const [restRows] = await conn.execute(
          'SELECT bill_prefix, bill_counter FROM restaurants WHERE id = ? FOR UPDATE',
          [restaurantId]
        );
        const prefix = (restRows[0]?.bill_prefix || 'INV').toUpperCase();
        const newCounter = (restRows[0]?.bill_counter || 0) + 1;
        const billNum = `${prefix}-${String(newCounter).padStart(5, '0')}`;
        await conn.execute('UPDATE restaurants SET bill_counter = ? WHERE id = ?', [newCounter, restaurantId]);
        await conn.execute('UPDATE orders SET bill_number = ?, bill_generated = 1, billed_at = NOW() WHERE id = ?', [billNum, orderId]);
      });
    }

    // Recalc so totals are fresh
    await recalcOrder(orderId);
    const [freshOrder] = await query('SELECT total_amount FROM orders WHERE id = ?', [orderId]);
    const totalAmount = freshOrder[0]?.total_amount || order.total_amount;

    // Build e-bill URL
    const frontendUrl = (process.env.FRONTEND_URL || 'http://localhost:3000').split(',')[0].trim();
    const ebillUrl = `${frontendUrl}/ebill/${ebillToken}`;

    const customerName = order.customer_name || 'Customer';

    // Send message(s) based on WA messaging mode
    if (waMode === 1) {
      // Mode 1: E-bill only (1 token)
      const variables = [customerName, order.restaurant_name, order.order_number || String(orderId), Number(totalAmount).toFixed(2), ebillUrl];
      await sendWhatsAppInvoice(order.customer_phone, variables);
    } else if (waMode === 2) {
      // Mode 2: E-bill + Review in same message (3.5 tokens)
      const variables = [customerName, order.restaurant_name, order.order_number || String(orderId), Number(totalAmount).toFixed(2), ebillUrl, googleReviewUrl];
      await sendWhatsAppInvoiceReview(order.customer_phone, variables);
    } else if (waMode === 3) {
      // Mode 3: E-bill + Review as separate messages (4.5 tokens)
      const invoiceVars = [customerName, order.restaurant_name, order.order_number || String(orderId), Number(totalAmount).toFixed(2), ebillUrl];
      await sendWhatsAppInvoice(order.customer_phone, invoiceVars);
      await sendWhatsAppReview(order.customer_phone, googleReviewUrl);
    }

    // Deduct tokens based on mode
    await query('UPDATE restaurants SET wa_tokens = wa_tokens - ? WHERE id = ? AND wa_tokens >= ?', [tokenCost, restaurantId, tokenCost]);

    return success(res, { ebillUrl }, 'E-bill sent successfully via WhatsApp.');
  } catch (err) {
    console.error('[E-Bill] sendEBill error:', err);
    return error(res, err.message || 'Failed to send e-bill.', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
}

/**
 * POST /ebill/:token/verify  (public, no auth)
 * Verifies the customer phone number against the order.
 */
async function verifyEBill(req, res) {
  try {
    const { token } = req.params;
    const { phone } = req.body;
    if (!phone) return error(res, 'Phone number is required.', HTTP_STATUS.BAD_REQUEST);

    const cleanPhone = phone.replace(/\D/g, '').slice(-10);
    if (cleanPhone.length < 10) return error(res, 'Enter a valid 10-digit mobile number.', HTTP_STATUS.BAD_REQUEST);

    const [rows] = await query(
      'SELECT id, customer_phone FROM orders WHERE ebill_token = ? LIMIT 1',
      [token]
    );
    if (!rows || rows.length === 0) return error(res, 'Invalid e-bill link.', HTTP_STATUS.NOT_FOUND);

    const storedPhone = (rows[0].customer_phone || '').replace(/\D/g, '').slice(-10);
    if (cleanPhone !== storedPhone) {
      return error(res, 'Mobile number does not match.', HTTP_STATUS.FORBIDDEN);
    }

    return success(res, { verified: true });
  } catch (err) {
    console.error('[E-Bill] verifyEBill error:', err);
    return error(res, 'Verification failed.', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
}

/**
 * GET /ebill/:token/data?phone=XXXXXXXXXX  (public, no auth)
 * Returns full bill data after phone verification.
 */
async function getEBillData(req, res) {
  try {
    const { token } = req.params;
    const { phone } = req.query;
    if (!phone) return error(res, 'Phone is required.', HTTP_STATUS.BAD_REQUEST);

    const cleanPhone = phone.replace(/\D/g, '').slice(-10);

    const [orderRows] = await query(
      `SELECT o.*, t.table_number, f.name AS floor_name,
              u.name AS waiter_name, u.role AS waiter_role,
              r.name AS restaurant_name, r.address, r.phone AS restaurant_phone, r.gstin, r.logo_url
       FROM orders o
       LEFT JOIN tables t ON t.id = o.table_id
       LEFT JOIN floors f ON f.id = t.floor_id
       LEFT JOIN users u ON u.id = o.waiter_id
       LEFT JOIN restaurants r ON r.id = o.restaurant_id
       WHERE o.ebill_token = ? LIMIT 1`,
      [token]
    );
    if (!orderRows || orderRows.length === 0) return error(res, 'Invalid e-bill link.', HTTP_STATUS.NOT_FOUND);
    const o = orderRows[0];

    const storedPhone = (o.customer_phone || '').replace(/\D/g, '').slice(-10);
    if (cleanPhone !== storedPhone) return error(res, 'Phone mismatch.', HTTP_STATUS.FORBIDDEN);

    // Fetch items (merged like generateBill)
    const [rawItems] = await query(
      "SELECT * FROM order_items WHERE order_id = ? AND status != 'cancelled' ORDER BY created_at ASC",
      [o.id]
    );

    const mergedMap = new Map();
    let grandTotalTax = 0;
    for (const item of rawItems) {
      const addonSig = item.addon_details ? JSON.stringify(item.addon_details) : 'none';
      const key = `${item.menu_item_id || 'null'}_${item.variant_id || 'null'}_${addonSig}`;
      const itemTax = o.tax_enabled ? parseFloat(item.tax_amount || 0) : 0;
      grandTotalTax += itemTax;
      const lineTotal = parseFloat(item.total_price || 0) - parseFloat(item.discount_amount || 0) + itemTax;

      if (mergedMap.has(key)) {
        const existing = mergedMap.get(key);
        existing.quantity += item.quantity;
        existing.total_price = parseFloat(existing.total_price) + parseFloat(item.total_price);
        existing.tax_amount = parseFloat(existing.tax_amount) + parseFloat(item.tax_amount);
        existing.discount_amount = parseFloat(existing.discount_amount || 0) + parseFloat(item.discount_amount || 0);
        existing.line_total = parseFloat(existing.line_total || 0) + lineTotal;
      } else {
        mergedMap.set(key, { ...item, line_total: lineTotal });
      }
    }
    const items = Array.from(mergedMap.values());

    const [adjustments] = await query(
      'SELECT * FROM bill_adjustments WHERE order_id = ? ORDER BY created_at ASC',
      [o.id]
    );

    const [billFormat] = await query(
      'SELECT * FROM bill_format_settings WHERE restaurant_id = ? LIMIT 1',
      [o.restaurant_id]
    );

    const taxBreakdown = [];
    if (o.tax_enabled && grandTotalTax > 0) {
      const halfAmount = parseFloat((grandTotalTax / 2).toFixed(2));
      taxBreakdown.push({ label: 'CGST', rate: null, taxAmount: halfAmount });
      taxBreakdown.push({ label: 'SGST', rate: null, taxAmount: halfAmount });
    }

    return success(res, {
      order: o,
      items,
      adjustments,
      billFormat: billFormat[0] || {},
      taxBreakdown,
      enableTax: o.tax_enabled !== 0,
    });
  } catch (err) {
    console.error('[E-Bill] getEBillData error:', err);
    return error(res, 'Failed to load bill.', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
}

module.exports = {
  getOrders,
  getKitchenOrders,
  getOrderById,
  createOrder,
  addOrderItems,
  updateOrderItem,
  removeOrderItem,
  sendKOT,
  markOrderPaid,
  generateBill,
  updateOrderCustomer,
  addOrderPayment,
  addBillAdjustment,
  removeBillAdjustment,
  updateKitchenItemStatus,
  closeOrder,
  reopenOrder,
  cancelOrder,
  getOrderPayments,
  getCustomerByPhone,
  getCustomers,
  getCustomerOrders,
  sendEBill,
  verifyEBill,
  getEBillData,
};
