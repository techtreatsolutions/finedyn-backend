'use strict';

const crypto = require('crypto');
const QRCode = require('qrcode');
const { query, transaction } = require('../config/database');
const { success, error } = require('../utils/responseHelper');
const { HTTP_STATUS } = require('../config/constants');
const { buildOrderNumber, recalcOrder } = require('../utils/orderHelpers');
const { generateTablePin } = require('../utils/pinHelper');
const { checkFeature } = require('../utils/featureEngine');
const { requestOTP, verifyOTP } = require('../utils/whatsappOtp');
const { decrypt } = require('../utils/encryption');
const { notifyRestaurantOwner } = require('./notification.controller');
const { sendPushToRole, sendPushToUser } = require('../utils/firebase');

/**
 * Initiate a refund for a given payment via the restaurant's active gateway.
 * @param {number} restaurantId
 * @param {string} paymentId — Gateway-specific payment ID (Razorpay: pay_xxx, Instamojo: MOJO_xxx)
 * @returns {object} Refund response
 */
async function initiateRefund(restaurantId, paymentId) {
  const [gwRows] = await query(
    "SELECT * FROM payment_gateway_settings WHERE restaurant_id = ? AND is_active = 1 LIMIT 1",
    [restaurantId]
  );
  if (!gwRows || gwRows.length === 0) throw new Error('Payment gateway not configured');
  const gw = gwRows[0];

  if (gw.gateway === 'razorpay') {
    let Razorpay;
    try { Razorpay = require('razorpay'); } catch (e) { throw new Error('Razorpay package not installed'); }
    const razorpay = new Razorpay({
      key_id: decrypt(gw.api_key_encrypted),
      key_secret: decrypt(gw.api_secret_encrypted),
    });
    const refund = await razorpay.payments.refund(paymentId, { speed: 'normal' });
    return refund;
  }

  if (gw.gateway === 'instamojo') {
    const axios = require('axios');
    const refundRes = await axios.post(
      'https://www.instamojo.com/api/1.1/refunds/',
      {
        payment_id: paymentId,
        type: 'QFL',
        body: 'Order cancelled — customer refund',
      },
      {
        headers: {
          'X-Api-Key': decrypt(gw.api_key_encrypted),
          'X-Auth-Token': decrypt(gw.api_secret_encrypted),
        },
      }
    );
    return refundRes.data.refund;
  }

  throw new Error('Unsupported payment gateway');
}

/* ════════════════════════════════════════════════════════════════════════════
   PUBLIC ENDPOINTS (no auth — customer-facing)
   ════════════════════════════════════════════════════════════════════════════ */

// GET /api/qr/:restaurantSlug/table/:tableId/info
// Lightweight endpoint — returns restaurant + table info (no session, no PIN)
async function getTableInfo(req, res) {
  try {
    const { restaurantSlug, tableId } = req.params;

    const [rRows] = await query(
      'SELECT id, name, logo_url, currency FROM restaurants WHERE slug = ? AND is_active = 1 LIMIT 1',
      [restaurantSlug]
    );
    if (!rRows || rRows.length === 0) return error(res, 'Restaurant not found.', HTTP_STATUS.NOT_FOUND);
    const restaurant = rRows[0];

    // Block if digital menu is disabled
    const digitalMenuEnabled = await checkFeature(restaurant.id, 'feature_digital_menu');
    if (!digitalMenuEnabled) return error(res, 'Digital menu is not available for this restaurant.', HTTP_STATUS.FORBIDDEN);

    const [tRows] = await query(
      'SELECT id, table_number, capacity FROM tables WHERE id = ? AND restaurant_id = ? AND is_active = 1 LIMIT 1',
      [tableId, restaurant.id]
    );
    if (!tRows || tRows.length === 0) return error(res, 'Table not found.', HTTP_STATUS.NOT_FOUND);

    // Fetch tax setting from bill format
    const [bfRows] = await query(
      'SELECT enable_tax FROM bill_format_settings WHERE restaurant_id = ? LIMIT 1',
      [restaurant.id]
    );
    const enableTax = bfRows && bfRows.length > 0 ? bfRows[0].enable_tax !== 0 : true;

    return success(res, {
      restaurant: { id: restaurant.id, name: restaurant.name, logoUrl: restaurant.logo_url, currency: restaurant.currency, enableTax },
      table: { id: tRows[0].id, tableNumber: tRows[0].table_number, capacity: tRows[0].capacity },
    });
  } catch (err) {
    console.error('[QR] getTableInfo error:', err);
    return error(res, 'Failed to get table info.', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
}

// POST /api/qr/:restaurantSlug/table/:tableId/verify-pin
// Body: { pin }
// Verifies 4-digit PIN, creates/finds session, returns full order data
async function verifyTablePin(req, res) {
  try {
    const { restaurantSlug, tableId } = req.params;
    const { pin } = req.body;
    if (!pin) return error(res, 'PIN is required.', HTTP_STATUS.BAD_REQUEST);

    // Lookup restaurant
    const [rRows] = await query(
      'SELECT id, name, logo_url, currency FROM restaurants WHERE slug = ? AND is_active = 1 LIMIT 1',
      [restaurantSlug]
    );
    if (!rRows || rRows.length === 0) return error(res, 'Restaurant not found.', HTTP_STATUS.NOT_FOUND);
    const restaurant = rRows[0];

    // Block if e-dine-in orders are disabled
    const edineEnabled = await checkFeature(restaurant.id, 'feature_edine_in_orders');
    if (!edineEnabled) return error(res, 'Online ordering is not available for this restaurant.', HTTP_STATUS.FORBIDDEN);

    // Get table with PIN
    const [tRows] = await query(
      'SELECT id, table_number, capacity, floor_id, status, current_order_id, table_pin FROM tables WHERE id = ? AND restaurant_id = ? AND is_active = 1 LIMIT 1',
      [tableId, restaurant.id]
    );
    if (!tRows || tRows.length === 0) return error(res, 'Table not found.', HTTP_STATUS.NOT_FOUND);
    const table = tRows[0];

    // Verify PIN
    if (table.table_pin !== pin) {
      return error(res, 'Invalid PIN. Please check the PIN displayed at your table.', HTTP_STATUS.FORBIDDEN);
    }

    // Find or create active session
    let sessionToken;
    const [existingSessions] = await query(
      'SELECT id, session_token FROM qr_sessions WHERE table_id = ? AND restaurant_id = ? AND is_active = 1 ORDER BY created_at DESC LIMIT 1',
      [tableId, restaurant.id]
    );

    if (existingSessions && existingSessions.length > 0) {
      sessionToken = existingSessions[0].session_token;
    } else {
      sessionToken = crypto.randomBytes(32).toString('hex');
      await query(
        'INSERT INTO qr_sessions (restaurant_id, table_id, session_token) VALUES (?, ?, ?)',
        [restaurant.id, tableId, sessionToken]
      );
    }

    // Check restaurant-level tax setting
    const [bfRows] = await query(
      'SELECT enable_tax FROM bill_format_settings WHERE restaurant_id = ? LIMIT 1',
      [restaurant.id]
    );
    const restaurantTaxEnabled = bfRows && bfRows.length > 0 ? bfRows[0].enable_tax !== 0 : true;

    // Get current order items if table is occupied
    let currentOrder = null;
    if (table.current_order_id) {
      const [oRows] = await query(
        "SELECT id, order_number, status, subtotal, tax_amount, total_amount, customer_name, customer_phone, tax_enabled FROM orders WHERE id = ? LIMIT 1",
        [table.current_order_id]
      );
      if (oRows && oRows.length > 0) {
        const [oItems] = await query(
          "SELECT item_name, quantity, total_price, tax_amount, status, addon_details FROM order_items WHERE order_id = ? AND status != 'cancelled' ORDER BY created_at ASC",
          [table.current_order_id]
        );
        const [adjustments] = await query(
          "SELECT id, label, adjustment_type, value_type, value, applied_amount FROM bill_adjustments WHERE order_id = ? ORDER BY created_at ASC",
          [table.current_order_id]
        );
        let taxBreakdown = [];
        if (restaurantTaxEnabled && oRows[0].tax_enabled) {
          const totalTax = oItems.reduce((s, i) => s + parseFloat(i.tax_amount || 0), 0);
          if (totalTax > 0) {
            const half = parseFloat((totalTax / 2).toFixed(2));
            taxBreakdown = [
              { label: 'CGST', amount: half },
              { label: 'SGST', amount: half },
            ];
          }
        }
        currentOrder = { ...oRows[0], items: oItems, adjustments, taxBreakdown };
      }
    }

    // Get pending QR orders for this session
    const [pendingOrders] = await query(
      "SELECT id, status, items, created_at, linked_order_id FROM qr_orders WHERE session_token = ? AND table_id = ? AND status IN ('pending', 'accepted') ORDER BY created_at DESC",
      [sessionToken, tableId]
    );

    return success(res, {
      sessionToken,
      restaurant: { name: restaurant.name, logoUrl: restaurant.logo_url, currency: restaurant.currency },
      table: { id: table.id, tableNumber: table.table_number, capacity: table.capacity, status: table.status },
      currentOrder,
      pendingQROrders: pendingOrders,
    });
  } catch (err) {
    console.error('[QR] verifyTablePin error:', err);
    return error(res, 'Failed to verify PIN.', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
}

// GET /api/qr/:restaurantSlug/table/:tableId/session?token=xxx
async function validateSession(req, res) {
  try {
    const { restaurantSlug, tableId } = req.params;
    const { token } = req.query;
    if (!token) return error(res, 'Session token is required.', HTTP_STATUS.BAD_REQUEST);

    // Lookup restaurant
    const [rRows] = await query(
      'SELECT id, name, logo_url, currency FROM restaurants WHERE slug = ? AND is_active = 1 LIMIT 1',
      [restaurantSlug]
    );
    if (!rRows || rRows.length === 0) return error(res, 'Restaurant not found.', HTTP_STATUS.NOT_FOUND);
    const restaurant = rRows[0];

    // Validate session
    const [sRows] = await query(
      'SELECT * FROM qr_sessions WHERE session_token = ? AND table_id = ? AND restaurant_id = ? AND is_active = 1 LIMIT 1',
      [token, tableId, restaurant.id]
    );
    if (!sRows || sRows.length === 0) return error(res, 'Session expired. Please re-enter your table PIN.', HTTP_STATUS.FORBIDDEN);

    // Get table info
    const [tRows] = await query(
      'SELECT id, table_number, capacity, floor_id, status, current_order_id FROM tables WHERE id = ? AND restaurant_id = ? AND is_active = 1 LIMIT 1',
      [tableId, restaurant.id]
    );
    if (!tRows || tRows.length === 0) return error(res, 'Table not found.', HTTP_STATUS.NOT_FOUND);
    const table = tRows[0];

    // Check restaurant-level tax setting
    const [bfRowsV] = await query(
      'SELECT enable_tax FROM bill_format_settings WHERE restaurant_id = ? LIMIT 1',
      [restaurant.id]
    );
    const restaurantTaxEnabled = bfRowsV && bfRowsV.length > 0 ? bfRowsV[0].enable_tax !== 0 : true;

    // Get current order items if table is occupied
    let currentOrder = null;
    if (table.current_order_id) {
      const [oRows] = await query(
        "SELECT id, order_number, status, subtotal, tax_amount, total_amount, customer_name, customer_phone, tax_enabled FROM orders WHERE id = ? LIMIT 1",
        [table.current_order_id]
      );
      if (oRows && oRows.length > 0) {
        const [oItems] = await query(
          "SELECT item_name, quantity, total_price, tax_amount, status, addon_details FROM order_items WHERE order_id = ? AND status != 'cancelled' ORDER BY created_at ASC",
          [table.current_order_id]
        );
        const [adjustments] = await query(
          "SELECT id, label, adjustment_type, value_type, value, applied_amount FROM bill_adjustments WHERE order_id = ? ORDER BY created_at ASC",
          [table.current_order_id]
        );
        let taxBreakdown = [];
        if (restaurantTaxEnabled && oRows[0].tax_enabled) {
          const totalTax = oItems.reduce((s, i) => s + parseFloat(i.tax_amount || 0), 0);
          if (totalTax > 0) {
            const half = parseFloat((totalTax / 2).toFixed(2));
            taxBreakdown = [
              { label: 'CGST', amount: half },
              { label: 'SGST', amount: half },
            ];
          }
        }
        currentOrder = { ...oRows[0], items: oItems, adjustments, taxBreakdown };
      }
    }

    // Get pending QR orders for this session
    const [pendingOrders] = await query(
      "SELECT id, status, items, created_at, linked_order_id FROM qr_orders WHERE session_token = ? AND table_id = ? AND status IN ('pending', 'accepted') ORDER BY created_at DESC",
      [token, tableId]
    );

    return success(res, {
      restaurant: { name: restaurant.name, logoUrl: restaurant.logo_url, currency: restaurant.currency },
      table: { id: table.id, tableNumber: table.table_number, capacity: table.capacity, status: table.status },
      currentOrder,
      pendingQROrders: pendingOrders,
    });
  } catch (err) {
    console.error('[QR] validateSession error:', err);
    return error(res, 'Failed to validate session.', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
}

// POST /api/qr/:restaurantSlug/table/:tableId/order
async function placeQROrder(req, res) {
  try {
    const { restaurantSlug, tableId } = req.params;
    const { sessionToken, customerName, customerPhone, items, specialInstructions } = req.body;

    if (!sessionToken) return error(res, 'Session token is required.', HTTP_STATUS.BAD_REQUEST);
    if (!items || !items.length) return error(res, 'Items are required.', HTTP_STATUS.BAD_REQUEST);

    // Lookup restaurant
    const [rRows] = await query(
      'SELECT id FROM restaurants WHERE slug = ? AND is_active = 1 LIMIT 1',
      [restaurantSlug]
    );
    if (!rRows || rRows.length === 0) return error(res, 'Restaurant not found.', HTTP_STATUS.NOT_FOUND);
    const restaurantId = rRows[0].id;

    // Block if e-dine-in orders are disabled
    const edineEnabled = await checkFeature(restaurantId, 'feature_edine_in_orders');
    if (!edineEnabled) return error(res, 'Online ordering is not available for this restaurant.', HTTP_STATUS.FORBIDDEN);

    // Validate session
    const [sRows] = await query(
      'SELECT id FROM qr_sessions WHERE session_token = ? AND table_id = ? AND restaurant_id = ? AND is_active = 1 LIMIT 1',
      [sessionToken, tableId, restaurantId]
    );
    if (!sRows || sRows.length === 0) return error(res, 'Session expired. Please re-enter your table PIN.', HTTP_STATUS.FORBIDDEN);

    // Validate & enrich items
    const enrichedItems = [];
    for (const item of items) {
      const { menuItemId, variantId, quantity, notes, addonIds } = item;
      if (!menuItemId || !quantity || quantity < 1) continue;

      let itemName, itemPrice, taxRate;
      if (variantId) {
        const [vRows] = await query(
          `SELECT mi.name AS item_name, mi.tax_rate, mv.name AS variant_name, mv.price
           FROM menu_item_variants mv JOIN menu_items mi ON mi.id = mv.menu_item_id
           WHERE mv.id = ? AND mi.id = ? AND mi.restaurant_id = ? LIMIT 1`,
          [variantId, menuItemId, restaurantId]
        );
        if (!vRows || vRows.length === 0) continue;
        itemName = `${vRows[0].item_name} (${vRows[0].variant_name})`;
        itemPrice = parseFloat(vRows[0].price);
        taxRate = parseFloat(vRows[0].tax_rate || 0);
      } else {
        const [iRows] = await query(
          'SELECT name, price, tax_rate FROM menu_items WHERE id = ? AND restaurant_id = ? AND is_available = 1 LIMIT 1',
          [menuItemId, restaurantId]
        );
        if (!iRows || iRows.length === 0) continue;
        itemName = iRows[0].name;
        itemPrice = parseFloat(iRows[0].price);
        taxRate = parseFloat(iRows[0].tax_rate || 0);
      }

      // Fetch addons
      let addonDetails = null;
      let addonPerUnit = 0;
      if (addonIds && addonIds.length > 0) {
        const ph = addonIds.map(() => '?').join(',');
        const [addonRows] = await query(
          `SELECT id, name, price FROM menu_item_addons WHERE id IN (${ph}) AND menu_item_id = ? AND is_available = 1`,
          [...addonIds, menuItemId]
        );
        if (addonRows && addonRows.length > 0) {
          addonDetails = addonRows.map(a => ({ id: a.id, name: a.name, price: parseFloat(a.price) }));
          addonPerUnit = addonDetails.reduce((sum, a) => sum + a.price, 0);
        }
      }

      enrichedItems.push({
        menuItemId, variantId: variantId || null, quantity,
        itemName, itemPrice, taxRate,
        addonIds: addonIds || [], addonDetails, addonPerUnit,
        notes: notes || null,
      });
    }

    if (enrichedItems.length === 0) return error(res, 'No valid items found.', HTTP_STATUS.BAD_REQUEST);

    // If customer provided name/phone, update the existing table order's customer info
    const [tableCheck] = await query('SELECT current_order_id FROM tables WHERE id = ? AND restaurant_id = ? LIMIT 1', [tableId, restaurantId]);
    if (tableCheck && tableCheck[0]?.current_order_id && (customerName || customerPhone)) {
      const sets = [];
      const vals = [];
      if (customerName) { sets.push('customer_name = ?'); vals.push(customerName); }
      if (customerPhone) { sets.push('customer_phone = ?'); vals.push(customerPhone); }
      if (sets.length) {
        vals.push(tableCheck[0].current_order_id);
        await query(`UPDATE orders SET ${sets.join(', ')} WHERE id = ?`, vals);
      }
    }

    // Insert QR order
    const [result] = await query(
      `INSERT INTO qr_orders (restaurant_id, table_id, session_token, customer_name, customer_phone, items, special_instructions, payment_preference)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [restaurantId, tableId, sessionToken, customerName || null, customerPhone || null,
        JSON.stringify(enrichedItems), specialInstructions || null, 'counter']
    );

    // Send push notification to restaurant staff (non-blocking)
    const [tblRows] = await query('SELECT table_number, assigned_waiter_id FROM tables WHERE id = ? LIMIT 1', [tableId]);
    const tblNum = tblRows?.[0]?.table_number || tableId;
    const assignedWaiterId = tblRows?.[0]?.assigned_waiter_id || null;
    const itemCount = enrichedItems.reduce((s, i) => s + i.quantity, 0);
    const pushTitle = 'New QR Order';
    const pushBody = `Table ${tblNum} — ${itemCount} item${itemCount > 1 ? 's' : ''}${customerName ? ` by ${customerName}` : ''}`;
    const pushData = { type: 'new_qr_order', qrOrderId: String(result.insertId), restaurantId: String(restaurantId) };

    // Notify owners/managers
    notifyRestaurantOwner(restaurantId, 'new_qr_order', pushTitle, pushBody).catch(() => {});
    // Notify cashiers
    sendPushToRole(restaurantId, 'cashier', pushTitle, pushBody, pushData).catch(() => {});
    // Notify assigned waiter
    if (assignedWaiterId) {
      sendPushToUser(assignedWaiterId, pushTitle, pushBody, pushData).catch(() => {});
    }

    return success(res, { qrOrderId: result.insertId }, 'Order placed! Waiting for staff confirmation.', HTTP_STATUS.CREATED);
  } catch (err) {
    console.error('[QR] placeQROrder error:', err);
    return error(res, 'Failed to place order.', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
}

// GET /api/qr/:restaurantSlug/table/:tableId/status?token=xxx&qrOrderId=xxx
async function getQROrderStatus(req, res) {
  try {
    const { tableId } = req.params;
    const { token, qrOrderId } = req.query;
    if (!token) return error(res, 'Token is required.', HTTP_STATUS.BAD_REQUEST);

    let statusQuery = "SELECT id, status, linked_order_id, reject_reason, created_at FROM qr_orders WHERE session_token = ? AND table_id = ?";
    const params = [token, tableId];

    if (qrOrderId) {
      statusQuery += " AND id = ?";
      params.push(qrOrderId);
    }
    statusQuery += " ORDER BY created_at DESC LIMIT 5";

    const [rows] = await query(statusQuery, params);
    return success(res, rows);
  } catch (err) {
    console.error('[QR] getQROrderStatus error:', err);
    return error(res, 'Failed to get status.', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
}

/* ════════════════════════════════════════════════════════════════════════════
   STAFF ENDPOINTS (authenticated)
   ════════════════════════════════════════════════════════════════════════════ */

// GET /api/qr-orders/pending
async function getPendingQROrders(req, res) {
  try {
    const [rows] = await query(
      `SELECT qo.*, t.table_number, f.name AS floor_name
       FROM qr_orders qo
       JOIN tables t ON t.id = qo.table_id
       LEFT JOIN floors f ON f.id = t.floor_id
       WHERE qo.restaurant_id = ? AND qo.status = 'pending'
       ORDER BY qo.created_at ASC`,
      [req.user.restaurantId]
    );
    return success(res, rows);
  } catch (err) {
    console.error('[QR] getPendingQROrders error:', err);
    return error(res, 'Failed to fetch pending orders.', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
}

// GET /api/qr-orders/my-pending — pending QR orders for waiter's assigned tables only
async function getMyPendingQROrders(req, res) {
  try {
    const [rows] = await query(
      `SELECT qo.*, t.table_number, f.name AS floor_name
       FROM qr_orders qo
       JOIN tables t ON t.id = qo.table_id
       LEFT JOIN floors f ON f.id = t.floor_id
       WHERE qo.restaurant_id = ? AND qo.status = 'pending' AND t.assigned_waiter_id = ?
       ORDER BY qo.created_at ASC`,
      [req.user.restaurantId, req.user.id]
    );
    return success(res, rows);
  } catch (err) {
    console.error('[QR] getMyPendingQROrders error:', err);
    return error(res, 'Failed to fetch pending orders.', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
}

// POST /api/qr-orders/:id/accept
async function acceptQROrder(req, res) {
  try {
    const { id } = req.params;
    const restaurantId = req.user.restaurantId;

    const [qrRows] = await query(
      "SELECT * FROM qr_orders WHERE id = ? AND restaurant_id = ? AND status = 'pending' LIMIT 1",
      [id, restaurantId]
    );
    if (!qrRows || qrRows.length === 0) return error(res, 'QR order not found or already processed.', HTTP_STATUS.NOT_FOUND);
    const qrOrder = qrRows[0];
    const items = typeof qrOrder.items === 'string' ? JSON.parse(qrOrder.items) : qrOrder.items;

    // Check bill limits before creating new order
    const { checkLimit } = require('../utils/featureEngine');
    const [[dailyCount]] = await query('SELECT COUNT(*) AS count FROM orders WHERE restaurant_id = ? AND DATE(created_at) = CURDATE()', [restaurantId]);
    const dayCheck = await checkLimit(restaurantId, 'max_bills_per_day', dailyCount.count);
    if (!dayCheck.allowed) return error(res, `Daily bill limit reached (${dayCheck.limit}). Please contact the restaurant.`, HTTP_STATUS.FORBIDDEN);

    const [[monthlyCount]] = await query('SELECT COUNT(*) AS count FROM orders WHERE restaurant_id = ? AND MONTH(created_at) = MONTH(CURDATE()) AND YEAR(created_at) = YEAR(CURDATE())', [restaurantId]);
    const monthCheck = await checkLimit(restaurantId, 'max_bills_per_month', monthlyCount.count);
    if (!monthCheck.allowed) return error(res, `Monthly bill limit reached (${monthCheck.limit}). Please contact the restaurant.`, HTTP_STATUS.FORBIDDEN);

    const result = await transaction(async (conn) => {
      // Check if table already has an active order
      const [tableRows] = await conn.execute(
        'SELECT current_order_id, status FROM tables WHERE id = ? AND restaurant_id = ? LIMIT 1',
        [qrOrder.table_id, restaurantId]
      );
      const table = tableRows[0];
      let orderId = table?.current_order_id;

      if (!orderId) {
        // Block if table is reserved
        if (table?.status === 'reserved') {
          throw { statusCode: 409, message: 'This table is reserved for an upcoming reservation. Please check with the staff.' };
        }

        // Create a new order for this table (include floor_id from table)
        const [tblFloor] = await conn.execute('SELECT floor_id FROM tables WHERE id = ? LIMIT 1', [qrOrder.table_id]);
        const qrFloorId = tblFloor[0]?.floor_id || null;
        const orderNumber = buildOrderNumber();
        const [insertRes] = await conn.execute(
          `INSERT INTO orders (restaurant_id, table_id, floor_id, order_number, order_type, status, customer_name, customer_phone, notes)
           VALUES (?, ?, ?, ?, 'dine_in', 'pending', ?, ?, ?)`,
          [restaurantId, qrOrder.table_id, qrFloorId, orderNumber, qrOrder.customer_name || null, qrOrder.customer_phone || null,
            qrOrder.special_instructions || null]
        );
        orderId = insertRes.insertId;

        // Mark table as occupied
        await conn.execute(
          'UPDATE tables SET status = ?, current_order_id = ? WHERE id = ?',
          ['occupied', orderId, qrOrder.table_id]
        );
      } else {
        // Always update customer info if provided by the customer
        if (qrOrder.customer_name || qrOrder.customer_phone) {
          const sets = [];
          const vals = [];
          if (qrOrder.customer_name) { sets.push('customer_name = ?'); vals.push(qrOrder.customer_name); }
          if (qrOrder.customer_phone) { sets.push('customer_phone = ?'); vals.push(qrOrder.customer_phone); }
          if (sets.length) {
            vals.push(orderId);
            await conn.execute(`UPDATE orders SET ${sets.join(', ')} WHERE id = ?`, vals);
          }
        }
      }

      // Add items to the order
      for (const item of items) {
        const effectiveUnitPrice = item.itemPrice + (item.addonPerUnit || 0);
        const totalPrice = effectiveUnitPrice * item.quantity;
        const taxAmount = (totalPrice * (item.taxRate || 0)) / 100;

        await conn.execute(
          `INSERT INTO order_items (order_id, restaurant_id, menu_item_id, variant_id, item_name, item_price, quantity, tax_rate, tax_amount, total_price, notes, addon_details, addon_per_unit)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [orderId, restaurantId, item.menuItemId, item.variantId || null, item.itemName,
            item.itemPrice, item.quantity, item.taxRate || 0, taxAmount, totalPrice,
            item.notes || null, item.addonDetails ? JSON.stringify(item.addonDetails) : null, item.addonPerUnit || 0]
        );
      }

      // Auto-send KOT for these items
      await conn.execute(
        "UPDATE order_items SET kot_sent = 1 WHERE order_id = ? AND kot_sent = 0 AND status = 'pending'",
        [orderId]
      );
      await conn.execute(
        "UPDATE orders SET status = 'preparing', kot_printed = 1 WHERE id = ? AND status IN ('pending', 'confirmed')",
        [orderId]
      );

      // Recalc order totals
      await recalcOrder(orderId, conn);

      // Update QR order as accepted
      await conn.execute(
        "UPDATE qr_orders SET status = 'accepted', accepted_by = ?, linked_order_id = ? WHERE id = ?",
        [req.user.id, orderId, id]
      );

      return orderId;
    });

    return success(res, { orderId: result }, 'QR order accepted and sent to kitchen.');
  } catch (err) {
    console.error('[QR] acceptQROrder error:', err);
    return error(res, 'Failed to accept QR order.', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
}

// POST /api/qr-orders/:id/reject
async function rejectQROrder(req, res) {
  try {
    const { id } = req.params;
    const { reason, initiateRefund: shouldRefund } = req.body;

    const [rows] = await query(
      "SELECT id, razorpay_payment_id FROM qr_orders WHERE id = ? AND restaurant_id = ? AND status = 'pending' LIMIT 1",
      [id, req.user.restaurantId]
    );
    if (!rows || rows.length === 0) return error(res, 'QR order not found or already processed.', HTTP_STATUS.NOT_FOUND);

    let refundStatus = null;
    if (rows[0].razorpay_payment_id) {
      if (shouldRefund) {
        try {
          await initiateRefund(req.user.restaurantId, rows[0].razorpay_payment_id);
          refundStatus = 'refunded';
        } catch (refundErr) {
          console.error('[QR] Auto-refund on reject failed:', refundErr);
          refundStatus = 'not_refunded';
          await query("UPDATE qr_orders SET status = 'rejected', reject_reason = ?, refund_status = ? WHERE id = ?", [reason || null, refundStatus, id]);
          return success(res, null, 'QR order rejected but refund failed. Please process refund manually.');
        }
      } else {
        refundStatus = 'not_refunded';
      }
    }

    await query(
      "UPDATE qr_orders SET status = 'rejected', reject_reason = ?, refund_status = ? WHERE id = ?",
      [reason || null, refundStatus, id]
    );

    return success(res, null, 'QR order rejected.');
  } catch (err) {
    console.error('[QR] rejectQROrder error:', err);
    return error(res, 'Failed to reject QR order.', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
}

/* ════════════════════════════════════════════════════════════════════════════
   TABLE QR MANAGEMENT (authenticated, owner/manager)
   ════════════════════════════════════════════════════════════════════════════ */

// POST /api/tables/:tableId/generate-qr
// Generates a PERMANENT QR code for the table (no session token in URL).
async function generateTableQR(req, res) {
  try {
    const { tableId } = req.params;
    const restaurantId = req.user.restaurantId;

    // Block if digital menu is disabled
    const digitalMenuEnabled = await checkFeature(restaurantId, 'feature_digital_menu');
    if (!digitalMenuEnabled) return error(res, 'Digital menu feature is not available in your plan.', HTTP_STATUS.FORBIDDEN);

    // Verify table
    const [tRows] = await query(
      'SELECT t.id, t.table_number, t.qr_code, r.slug FROM tables t JOIN restaurants r ON r.id = t.restaurant_id WHERE t.id = ? AND t.restaurant_id = ? AND t.is_active = 1 LIMIT 1',
      [tableId, restaurantId]
    );
    if (!tRows || tRows.length === 0) return error(res, 'Table not found.', HTTP_STATUS.NOT_FOUND);
    const { slug, table_number, qr_code } = tRows[0];

    // If QR code already exists and is valid, return it (QR is permanent / lifetime)
    if (qr_code && qr_code.startsWith('data:image/png;base64,') && qr_code.length > 1000) {
      const frontendUrl = (process.env.FRONTEND_URL || 'http://localhost:3000').split(',')[0].trim();
      const qrUrl = `${frontendUrl}/qr/${slug}/${tableId}`;
      return success(res, {
        qrCodeDataUrl: qr_code,
        qrUrl,
        tableNumber: table_number,
      }, 'QR code already exists.');
    }

    // Build permanent QR URL — TableQRRouter decides POSS vs QR flow on the frontend
    const frontendUrl = (process.env.FRONTEND_URL || 'http://localhost:3000').split(',')[0].trim();
    const qrUrl = `${frontendUrl}/qr/${slug}/${tableId}`;

    // Generate QR code as data URL
    const qrDataUrl = await QRCode.toDataURL(qrUrl, {
      width: 400, margin: 2,
      color: { dark: '#000000', light: '#ffffff' },
    });

    // Store in table
    await query('UPDATE tables SET qr_code = ? WHERE id = ?', [qrDataUrl, tableId]);

    return success(res, {
      qrCodeDataUrl: qrDataUrl,
      qrUrl,
      tableNumber: table_number,
    }, 'QR code generated.');
  } catch (err) {
    console.error('[QR] generateTableQR error:', err);
    return error(res, 'Failed to generate QR code.', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
}

// POST /api/tables/:tableId/reset-session
// Resets the session and regenerates PIN — QR code stays the same
async function resetTableSession(req, res) {
  try {
    const { tableId } = req.params;
    const restaurantId = req.user.restaurantId;

    // Deactivate all sessions (next PIN verification will create a fresh session)
    await query('UPDATE qr_sessions SET is_active = 0 WHERE table_id = ? AND restaurant_id = ?', [tableId, restaurantId]);

    // Reject pending QR orders
    await query(
      "UPDATE qr_orders SET status = 'expired' WHERE table_id = ? AND restaurant_id = ? AND status = 'pending'",
      [tableId, restaurantId]
    );

    // Regenerate PIN only if e-dine-in orders are enabled
    const edineOn = await checkFeature(restaurantId, 'feature_edine_in_orders');
    let newPin = null;
    if (edineOn) {
      newPin = generateTablePin();
      await query('UPDATE tables SET table_pin = ? WHERE id = ? AND restaurant_id = ?', [newPin, tableId, restaurantId]);
    }

    // NOTE: Do NOT clear qr_code — QR is permanent

    return success(res, { pin: newPin }, 'QR session reset. QR code remains the same.');
  } catch (err) {
    console.error('[QR] resetTableSession error:', err);
    return error(res, 'Failed to reset session.', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
}

// GET /api/tables/:tableId/qr-download
async function downloadTableQR(req, res) {
  try {
    const { tableId } = req.params;
    const restaurantId = req.user.restaurantId;

    const [rows] = await query(
      'SELECT qr_code, table_number FROM tables WHERE id = ? AND restaurant_id = ? LIMIT 1',
      [tableId, restaurantId]
    );
    if (!rows || rows.length === 0) return error(res, 'Table not found.', HTTP_STATUS.NOT_FOUND);
    if (!rows[0].qr_code) return error(res, 'No QR code generated for this table. Generate one first.', HTTP_STATUS.NOT_FOUND);

    // Convert data URL to buffer
    const dataUrl = rows[0].qr_code;
    const base64Data = dataUrl.replace(/^data:image\/png;base64,/, '');
    const buffer = Buffer.from(base64Data, 'base64');

    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Content-Disposition', `attachment; filename="table-${rows[0].table_number}-qr.png"`);
    return res.send(buffer);
  } catch (err) {
    console.error('[QR] downloadTableQR error:', err);
    return error(res, 'Failed to download QR code.', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
}

/* ════════════════════════════════════════════════════════════════════════════
   QR MODEL — PUBLIC ENDPOINTS (no auth, no PIN)
   For restaurants with type = 'qr'
   ════════════════════════════════════════════════════════════════════════════ */

// GET /api/qr/:restaurantSlug/info — restaurant info + QR settings
async function getQRRestaurantInfo(req, res) {
  try {
    const { restaurantSlug } = req.params;
    const [rRows] = await query(
      'SELECT id, name, slug, logo_url, currency, type FROM restaurants WHERE slug = ? AND is_active = 1 LIMIT 1',
      [restaurantSlug]
    );
    if (!rRows || rRows.length === 0) return error(res, 'Restaurant not found.', HTTP_STATUS.NOT_FOUND);
    const restaurant = rRows[0];

    // Fetch QR settings
    const [qsRows] = await query('SELECT * FROM qr_settings WHERE restaurant_id = ? LIMIT 1', [restaurant.id]);
    const qrSettings = qsRows && qsRows.length > 0 ? qsRows[0] : { enable_dine_in: 1, enable_takeaway: 1, enable_delivery: 0, payment_acceptance: 'both' };

    // Tax toggle comes from bill_format_settings (the single source of truth)
    const [bfTaxRows] = await query('SELECT enable_tax FROM bill_format_settings WHERE restaurant_id = ? LIMIT 1', [restaurant.id]);
    const enableTax = bfTaxRows && bfTaxRows.length > 0 ? bfTaxRows[0].enable_tax !== 0 : true;

    // Check if restaurant has an active payment gateway
    const [gwRows] = await query(
      'SELECT id, gateway FROM payment_gateway_settings WHERE restaurant_id = ? AND is_active = 1 LIMIT 1',
      [restaurant.id]
    );
    const hasPaymentGateway = gwRows && gwRows.length > 0;
    const paymentGateway = hasPaymentGateway ? gwRows[0].gateway : null;

    return success(res, {
      restaurant: { id: restaurant.id, name: restaurant.name, slug: restaurant.slug, logoUrl: restaurant.logo_url, currency: restaurant.currency, type: restaurant.type, enableTax },
      qrSettings: {
        enableDineIn: !!qrSettings.enable_dine_in,
        enableTakeaway: !!qrSettings.enable_takeaway,
        enableDelivery: !!qrSettings.enable_delivery,
        paymentAcceptance: qrSettings.payment_acceptance,
        enableTax,
      },
      hasPaymentGateway,
      paymentGateway,
    });
  } catch (err) {
    console.error('[QR] getQRRestaurantInfo error:', err);
    return error(res, 'Failed to get restaurant info.', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
}

// GET /api/qr/:restaurantSlug/floors-tables — public list for dine-in table selection
async function getQRFloorsTables(req, res) {
  try {
    const { restaurantSlug } = req.params;
    const [rRows] = await query('SELECT id FROM restaurants WHERE slug = ? AND is_active = 1 LIMIT 1', [restaurantSlug]);
    if (!rRows || rRows.length === 0) return error(res, 'Restaurant not found.', HTTP_STATUS.NOT_FOUND);
    const restaurantId = rRows[0].id;

    const [floors] = await query('SELECT id, name FROM floors WHERE restaurant_id = ? AND is_active = 1 ORDER BY name ASC', [restaurantId]);
    const [tables] = await query('SELECT id, floor_id, table_number, capacity FROM tables WHERE restaurant_id = ? AND is_active = 1 ORDER BY table_number ASC', [restaurantId]);

    const result = (floors || []).map(f => ({
      ...f,
      tables: (tables || []).filter(t => t.floor_id === f.id),
    }));

    return success(res, result);
  } catch (err) {
    console.error('[QR] getQRFloorsTables error:', err);
    return error(res, 'Failed to get floors and tables.', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
}

// GET /api/qr/:restaurantSlug/table-info?tableId=X — public endpoint to get table details for dine-in QR
async function getQRTableInfo(req, res) {
  try {
    const { restaurantSlug } = req.params;
    const { tableId } = req.query;
    if (!tableId) return error(res, 'tableId is required.', HTTP_STATUS.BAD_REQUEST);

    const [rRows] = await query('SELECT id FROM restaurants WHERE slug = ? AND is_active = 1 LIMIT 1', [restaurantSlug]);
    if (!rRows || rRows.length === 0) return error(res, 'Restaurant not found.', HTTP_STATUS.NOT_FOUND);

    const [tRows] = await query(
      `SELECT t.id, t.table_number, t.capacity, f.id AS floor_id, f.name AS floor_name
       FROM tables t LEFT JOIN floors f ON f.id = t.floor_id
       WHERE t.id = ? AND t.restaurant_id = ? AND t.is_active = 1 LIMIT 1`,
      [tableId, rRows[0].id]
    );
    if (!tRows || tRows.length === 0) return error(res, 'Table not found.', HTTP_STATUS.NOT_FOUND);

    return success(res, tRows[0]);
  } catch (err) {
    console.error('[QR] getQRTableInfo error:', err);
    return error(res, 'Failed to get table info.', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
}

// POST /api/qr/:restaurantSlug/order — place order without PIN/session (QR model)
async function placeQRModelOrder(req, res) {
  try {
    const { restaurantSlug } = req.params;
    const { orderType, tableId, customerName, customerPhone, deliveryAddress, items, specialInstructions, paymentPreference, razorpayOrderId, razorpayPaymentId } = req.body;

    if (!items || !items.length) return error(res, 'Items are required.', HTTP_STATUS.BAD_REQUEST);
    if (!orderType) return error(res, 'Order type is required.', HTTP_STATUS.BAD_REQUEST);

    const [rRows] = await query('SELECT id FROM restaurants WHERE slug = ? AND is_active = 1 LIMIT 1', [restaurantSlug]);
    if (!rRows || rRows.length === 0) return error(res, 'Restaurant not found.', HTTP_STATUS.NOT_FOUND);
    const restaurantId = rRows[0].id;

    // Validate order type against QR settings
    const [qsRows] = await query('SELECT * FROM qr_settings WHERE restaurant_id = ? LIMIT 1', [restaurantId]);
    const qs = qsRows && qsRows.length > 0 ? qsRows[0] : { enable_dine_in: 1, enable_takeaway: 1, enable_delivery: 0, payment_acceptance: 'both' };

    // Tax toggle from bill_format_settings (single source of truth)
    const [bfTaxRows2] = await query('SELECT enable_tax FROM bill_format_settings WHERE restaurant_id = ? LIMIT 1', [restaurantId]);
    const enableTax = bfTaxRows2 && bfTaxRows2.length > 0 ? bfTaxRows2[0].enable_tax !== 0 : true;

    // Dine-in from table QR (tableId provided) is always allowed; standalone dine-in respects qr_settings
    if (orderType === 'dine_in' && !qs.enable_dine_in && !tableId) return error(res, 'Dine-in orders are not enabled.', HTTP_STATUS.BAD_REQUEST);
    if (orderType === 'takeaway' && !qs.enable_takeaway) return error(res, 'Takeaway orders are not enabled.', HTTP_STATUS.BAD_REQUEST);
    if (orderType === 'delivery' && !qs.enable_delivery) return error(res, 'Delivery orders are not enabled.', HTTP_STATUS.BAD_REQUEST);

    if (orderType === 'dine_in' && !tableId) return error(res, 'Table selection is required for dine-in orders.', HTTP_STATUS.BAD_REQUEST);
    if (orderType === 'delivery' && !deliveryAddress) return error(res, 'Delivery address is required.', HTTP_STATUS.BAD_REQUEST);

    // Determine payment preference
    const pref = paymentPreference === 'online' ? 'online' : 'counter';

    // For counter payment, phone must be verified via OTP
    if (pref === 'counter') {
      if (!customerPhone) return error(res, 'Phone number is required for pay-at-counter orders.', HTTP_STATUS.BAD_REQUEST);
    }

    // Validate & enrich items (same logic as placeQROrder)
    const enrichedItems = [];
    for (const item of items) {
      const { menuItemId, variantId, quantity, notes, addonIds } = item;
      if (!menuItemId || !quantity || quantity < 1) continue;

      let itemName, itemPrice, taxRate;
      if (variantId) {
        const [vRows] = await query(
          `SELECT mi.name AS item_name, mi.tax_rate, mv.name AS variant_name, mv.price
           FROM menu_item_variants mv JOIN menu_items mi ON mi.id = mv.menu_item_id
           WHERE mv.id = ? AND mi.id = ? AND mi.restaurant_id = ? LIMIT 1`,
          [variantId, menuItemId, restaurantId]
        );
        if (!vRows || vRows.length === 0) continue;
        itemName = `${vRows[0].item_name} (${vRows[0].variant_name})`;
        itemPrice = parseFloat(vRows[0].price);
        taxRate = parseFloat(vRows[0].tax_rate || 0);
      } else {
        const [iRows] = await query(
          'SELECT name, price, tax_rate FROM menu_items WHERE id = ? AND restaurant_id = ? AND is_available = 1 LIMIT 1',
          [menuItemId, restaurantId]
        );
        if (!iRows || iRows.length === 0) continue;
        itemName = iRows[0].name;
        itemPrice = parseFloat(iRows[0].price);
        taxRate = parseFloat(iRows[0].tax_rate || 0);
      }

      let addonDetails = null;
      let addonPerUnit = 0;
      if (addonIds && addonIds.length > 0) {
        const ph = addonIds.map(() => '?').join(',');
        const [addonRows] = await query(
          `SELECT id, name, price FROM menu_item_addons WHERE id IN (${ph}) AND menu_item_id = ? AND is_available = 1`,
          [...addonIds, menuItemId]
        );
        if (addonRows && addonRows.length > 0) {
          addonDetails = addonRows.map(a => ({ id: a.id, name: a.name, price: parseFloat(a.price) }));
          addonPerUnit = addonDetails.reduce((sum, a) => sum + a.price, 0);
        }
      }

      enrichedItems.push({
        menuItemId, variantId: variantId || null, quantity,
        itemName, itemPrice, taxRate,
        addonIds: addonIds || [], addonDetails, addonPerUnit,
        notes: notes || null,
      });
    }

    if (enrichedItems.length === 0) return error(res, 'No valid items found.', HTTP_STATUS.BAD_REQUEST);

    const [result] = await query(
      `INSERT INTO qr_orders (restaurant_id, table_id, order_type, customer_name, customer_phone, delivery_address, items, special_instructions, payment_preference, razorpay_order_id, razorpay_payment_id, tax_enabled)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [restaurantId, tableId || null, orderType, customerName || null, customerPhone || null,
        orderType === 'delivery' ? (deliveryAddress || null) : null,
        JSON.stringify(enrichedItems), specialInstructions || null, pref,
        razorpayOrderId || null, razorpayPaymentId || null, enableTax ? 1 : 0]
    );

    // Send push notification to restaurant staff (non-blocking)
    const itemCount = enrichedItems.reduce((s, i) => s + i.quantity, 0);
    let pushBody = `${orderType === 'dine_in' ? 'Dine-in' : orderType === 'takeaway' ? 'Takeaway' : 'Delivery'} — ${itemCount} item${itemCount > 1 ? 's' : ''}`;
    if (customerName) pushBody += ` by ${customerName}`;
    if (orderType === 'dine_in' && tableId) {
      const [tblR] = await query('SELECT table_number FROM tables WHERE id = ? LIMIT 1', [tableId]);
      if (tblR?.[0]?.table_number) pushBody = `Table ${tblR[0].table_number} — ${pushBody}`;
    }
    const pushData = { type: 'new_qr_order', qrOrderId: String(result.insertId), restaurantId: String(restaurantId) };
    notifyRestaurantOwner(restaurantId, 'new_qr_order', 'New QR Order', pushBody).catch(() => {});
    sendPushToRole(restaurantId, 'cashier', 'New QR Order', pushBody, pushData).catch(() => {});

    return success(res, { qrOrderId: result.insertId }, 'Order placed! Waiting for restaurant confirmation.', HTTP_STATUS.CREATED);
  } catch (err) {
    console.error('[QR] placeQRModelOrder error:', err);
    return error(res, 'Failed to place order.', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
}

// POST /api/qr/:restaurantSlug/create-payment — create Razorpay order for online QR payment
async function createQRPayment(req, res) {
  try {
    const { restaurantSlug } = req.params;
    const { items, orderType } = req.body;
    if (!items || !items.length) return error(res, 'Items are required.', HTTP_STATUS.BAD_REQUEST);

    const [rRows] = await query('SELECT id FROM restaurants WHERE slug = ? AND is_active = 1 LIMIT 1', [restaurantSlug]);
    if (!rRows || rRows.length === 0) return error(res, 'Restaurant not found.', HTTP_STATUS.NOT_FOUND);
    const restaurantId = rRows[0].id;

    // Tax toggle from bill_format_settings (single source of truth)
    const [bfTaxRows] = await query('SELECT enable_tax FROM bill_format_settings WHERE restaurant_id = ? LIMIT 1', [restaurantId]);
    const enableTax = bfTaxRows && bfTaxRows.length > 0 ? bfTaxRows[0].enable_tax !== 0 : true;

    // Enrich items and compute total
    let subtotal = 0;
    let taxTotal = 0;
    for (const item of items) {
      const { menuItemId, variantId, quantity, addonIds } = item;
      if (!menuItemId || !quantity || quantity < 1) continue;
      let itemPrice, taxRate;
      if (variantId) {
        const [vRows] = await query(
          `SELECT mi.tax_rate, mv.price FROM menu_item_variants mv JOIN menu_items mi ON mi.id = mv.menu_item_id WHERE mv.id = ? AND mi.id = ? AND mi.restaurant_id = ? LIMIT 1`,
          [variantId, menuItemId, restaurantId]);
        if (!vRows || vRows.length === 0) continue;
        itemPrice = parseFloat(vRows[0].price);
        taxRate = parseFloat(vRows[0].tax_rate || 0);
      } else {
        const [iRows] = await query('SELECT price, tax_rate FROM menu_items WHERE id = ? AND restaurant_id = ? AND is_available = 1 LIMIT 1', [menuItemId, restaurantId]);
        if (!iRows || iRows.length === 0) continue;
        itemPrice = parseFloat(iRows[0].price);
        taxRate = parseFloat(iRows[0].tax_rate || 0);
      }
      let addonPerUnit = 0;
      if (addonIds && addonIds.length > 0) {
        const ph = addonIds.map(() => '?').join(',');
        const [addonRows] = await query(`SELECT price FROM menu_item_addons WHERE id IN (${ph}) AND menu_item_id = ? AND is_available = 1`, [...addonIds, menuItemId]);
        if (addonRows) addonPerUnit = addonRows.reduce((s, a) => s + parseFloat(a.price), 0);
      }
      const lineTotal = (itemPrice + addonPerUnit) * quantity;
      subtotal += lineTotal;
      if (enableTax) taxTotal += lineTotal * taxRate / 100;
    }

    const grandTotal = subtotal + taxTotal;
    if (grandTotal <= 0) return error(res, 'Invalid order total.', HTTP_STATUS.BAD_REQUEST);

    // Get active payment gateway
    const [gwRows] = await query(
      "SELECT * FROM payment_gateway_settings WHERE restaurant_id = ? AND is_active = 1 LIMIT 1",
      [restaurantId]);
    if (!gwRows || gwRows.length === 0) return error(res, 'Payment gateway not configured.', HTTP_STATUS.BAD_REQUEST);
    const gw = gwRows[0];

    if (gw.gateway === 'razorpay') {
      let Razorpay;
      try { Razorpay = require('razorpay'); } catch (e) {
        return error(res, 'Razorpay package not installed.', HTTP_STATUS.SERVER_ERROR);
      }
      const razorpay = new Razorpay({ key_id: decrypt(gw.api_key_encrypted), key_secret: decrypt(gw.api_secret_encrypted) });

      const rpOrder = await razorpay.orders.create({
        amount: Math.round(grandTotal * 100),
        currency: 'INR',
        receipt: `qr_${restaurantId}_${Date.now()}`,
        notes: { restaurantId: String(restaurantId), orderType: orderType || 'takeaway' },
      });

      return success(res, {
        gateway: 'razorpay',
        razorpayOrderId: rpOrder.id,
        amount: rpOrder.amount,
        currency: rpOrder.currency,
        keyId: decrypt(gw.api_key_encrypted),
      });
    }

    if (gw.gateway === 'instamojo') {
      const axios = require('axios');
      const redirectUrl = `${process.env.FRONTEND_URL}/qr/${restaurantSlug}/order`;

      const imResponse = await axios.post(
        'https://www.instamojo.com/api/1.1/payment-requests/',
        {
          purpose: `QR Order — ${orderType || 'takeaway'}`,
          amount: grandTotal.toFixed(2),
          buyer_name: req.body.customerName || 'Guest',
          phone: req.body.customerPhone || '',
          redirect_url: redirectUrl,
          allow_repeated_payments: false,
        },
        {
          headers: {
            'X-Api-Key': decrypt(gw.api_key_encrypted),
            'X-Auth-Token': decrypt(gw.api_secret_encrypted),
          },
        }
      );

      const payReq = imResponse.data.payment_request;
      return success(res, {
        gateway: 'instamojo',
        paymentRequestId: payReq.id,
        paymentUrl: payReq.longurl,
        amount: Math.round(grandTotal * 100),
      });
    }

    return error(res, 'Unsupported payment gateway.', HTTP_STATUS.BAD_REQUEST);
  } catch (err) {
    console.error('[QR] createQRPayment error:', err);
    return error(res, 'Failed to create payment.', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
}

// POST /api/qr/:restaurantSlug/verify-payment — verify payment (Razorpay signature or Instamojo status)
async function verifyQRPayment(req, res) {
  try {
    const { restaurantSlug } = req.params;
    const { gateway: gwType, razorpayOrderId, razorpayPaymentId, razorpaySignature, paymentRequestId, paymentId } = req.body;

    const [rRows] = await query('SELECT id FROM restaurants WHERE slug = ? AND is_active = 1 LIMIT 1', [restaurantSlug]);
    if (!rRows || rRows.length === 0) return error(res, 'Restaurant not found.', HTTP_STATUS.NOT_FOUND);
    const restaurantId = rRows[0].id;

    const [gwRows] = await query(
      "SELECT * FROM payment_gateway_settings WHERE restaurant_id = ? AND is_active = 1 LIMIT 1",
      [restaurantId]);
    if (!gwRows || gwRows.length === 0) return error(res, 'Payment gateway not configured.', HTTP_STATUS.BAD_REQUEST);
    const gw = gwRows[0];

    if (gw.gateway === 'razorpay') {
      if (!razorpayOrderId || !razorpayPaymentId || !razorpaySignature) {
        return error(res, 'Payment details are required.', HTTP_STATUS.BAD_REQUEST);
      }
      const body = razorpayOrderId + '|' + razorpayPaymentId;
      const expectedSig = crypto.createHmac('sha256', decrypt(gw.api_secret_encrypted)).update(body).digest('hex');
      if (expectedSig !== razorpaySignature) return error(res, 'Payment verification failed.', HTTP_STATUS.BAD_REQUEST);
      return success(res, { verified: true, gateway: 'razorpay' }, 'Payment verified.');
    }

    if (gw.gateway === 'instamojo') {
      if (!paymentRequestId || !paymentId) {
        return error(res, 'Payment details are required.', HTTP_STATUS.BAD_REQUEST);
      }
      const axios = require('axios');
      const imRes = await axios.get(
        `https://www.instamojo.com/api/1.1/payment-requests/${paymentRequestId}/${paymentId}/`,
        {
          headers: {
            'X-Api-Key': decrypt(gw.api_key_encrypted),
            'X-Auth-Token': decrypt(gw.api_secret_encrypted),
          },
        }
      );
      const payment = imRes.data.payment_request;
      if (payment.status !== 'Completed') return error(res, 'Payment not completed.', HTTP_STATUS.BAD_REQUEST);
      return success(res, { verified: true, gateway: 'instamojo', instamojoPaymentId: paymentId }, 'Payment verified.');
    }

    return error(res, 'Unsupported payment gateway.', HTTP_STATUS.BAD_REQUEST);
  } catch (err) {
    console.error('[QR] verifyQRPayment error:', err);
    return error(res, 'Payment verification failed.', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
}

// POST /api/qr/:restaurantSlug/refund-payment — auto-refund when order placement fails after payment
async function refundQRPayment(req, res) {
  try {
    const { restaurantSlug } = req.params;
    const { paymentId } = req.body;
    if (!paymentId) return error(res, 'Payment ID is required.', HTTP_STATUS.BAD_REQUEST);

    const [rRows] = await query('SELECT id FROM restaurants WHERE slug = ? AND is_active = 1 LIMIT 1', [restaurantSlug]);
    if (!rRows || rRows.length === 0) return error(res, 'Restaurant not found.', HTTP_STATUS.NOT_FOUND);

    const refund = await initiateRefund(rRows[0].id, paymentId);
    return success(res, { refundId: refund.id }, 'Refund initiated successfully.');
  } catch (err) {
    console.error('[QR] refundQRPayment error:', err);
    return error(res, 'Failed to initiate refund.', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
}

// GET /api/qr/:restaurantSlug/order-status?qrOrderId=1 or ?qrOrderIds=1,2,3 — public order status polling
async function getQRModelOrderStatus(req, res) {
  try {
    const { restaurantSlug } = req.params;
    const { qrOrderId, qrOrderIds } = req.query;

    // Support single ID (legacy) or comma-separated IDs
    let ids = [];
    if (qrOrderIds) {
      ids = qrOrderIds.split(',').map(id => parseInt(id, 10)).filter(id => id > 0);
    } else if (qrOrderId) {
      ids = [parseInt(qrOrderId, 10)];
    }
    if (ids.length === 0) return error(res, 'qrOrderId or qrOrderIds is required.', HTTP_STATUS.BAD_REQUEST);

    const [rRows] = await query('SELECT id FROM restaurants WHERE slug = ? AND is_active = 1 LIMIT 1', [restaurantSlug]);
    if (!rRows || rRows.length === 0) return error(res, 'Restaurant not found.', HTTP_STATUS.NOT_FOUND);

    const placeholders = ids.map(() => '?').join(',');
    const [rows] = await query(
      `SELECT qo.id, qo.status, qo.order_type, qo.linked_order_id, qo.reject_reason, qo.payment_preference, qo.razorpay_payment_id, qo.refund_status, qo.created_at,
              o.payment_status,
              t.table_number, f.name AS floor_name
       FROM qr_orders qo
       LEFT JOIN orders o ON o.id = qo.linked_order_id
       LEFT JOIN tables t ON t.id = qo.table_id
       LEFT JOIN floors f ON f.id = t.floor_id
       WHERE qo.id IN (${placeholders}) AND qo.restaurant_id = ?`,
      [...ids, rRows[0].id]
    );

    // For single ID (legacy), return single object; for multiple, return array
    if (!qrOrderIds && qrOrderId) {
      return success(res, rows && rows.length > 0 ? rows[0] : null);
    }
    return success(res, rows || []);
  } catch (err) {
    console.error('[QR] getQRModelOrderStatus error:', err);
    return error(res, 'Failed to get status.', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
}

/* ════════════════════════════════════════════════════════════════════════════
   QR MODEL — STAFF ENDPOINTS (authenticated)
   ════════════════════════════════════════════════════════════════════════════ */

// GET /api/qr-orders/list — all QR orders for QR model restaurants
async function getQRModelOrders(req, res) {
  try {
    const restaurantId = req.user.restaurantId;
    const { status, orderType, paymentStatus, date, page = 1, limit = 50 } = req.query;
    const offset = (Math.max(1, parseInt(page)) - 1) * parseInt(limit);

    let where = 'WHERE qo.restaurant_id = ?';
    const params = [restaurantId];

    if (status && status !== 'all') { where += ' AND qo.status = ?'; params.push(status); }
    if (orderType && orderType !== 'all') { where += ' AND qo.order_type = ?'; params.push(orderType); }
    if (date) { where += ' AND DATE(qo.created_at) = ?'; params.push(date); }

    // Payment status filter requires JOIN on orders
    let havingClause = '';
    if (paymentStatus === 'paid') { havingClause = 'HAVING o.payment_status = \'paid\''; }
    else if (paymentStatus === 'unpaid') { havingClause = 'HAVING (o.payment_status IS NULL OR o.payment_status != \'paid\')'; }

    // For count query with payment filter, we need the join
    const countSql = paymentStatus && paymentStatus !== 'all'
      ? `SELECT COUNT(*) AS total FROM qr_orders qo LEFT JOIN orders o ON o.id = qo.linked_order_id ${where} ${havingClause.replace('HAVING', 'AND')}`
      : `SELECT COUNT(*) AS total FROM qr_orders qo ${where}`;
    const [[countRow]] = await query(countSql, params);

    const [rows] = await query(
      `SELECT qo.*, t.table_number, f.name AS floor_name,
              o.order_number, o.payment_status, o.subtotal AS order_subtotal, o.tax_amount AS order_tax, o.total_amount AS order_total, o.tax_enabled AS linked_tax_enabled
       FROM qr_orders qo
       LEFT JOIN tables t ON t.id = qo.table_id
       LEFT JOIN floors f ON f.id = t.floor_id
       LEFT JOIN orders o ON o.id = qo.linked_order_id
       ${where}
       ${paymentStatus === 'paid' ? 'AND o.payment_status = \'paid\'' : ''}
       ${paymentStatus === 'unpaid' ? 'AND (o.payment_status IS NULL OR o.payment_status != \'paid\')' : ''}
       ORDER BY qo.created_at DESC
       LIMIT ? OFFSET ?`,
      [...params, parseInt(limit), offset]
    );

    return success(res, { orders: rows, total: countRow.total, page: parseInt(page), limit: parseInt(limit) });
  } catch (err) {
    console.error('[QR] getQRModelOrders error:', err);
    return error(res, 'Failed to fetch orders.', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
}

// PATCH /api/qr-orders/:id/update-status — update QR order status (for QR model)
async function updateQROrderStatus(req, res) {
  try {
    const { id } = req.params;
    const { status: newStatus } = req.body;
    const restaurantId = req.user.restaurantId;

    const validStatuses = ['pending', 'accepted', 'rejected', 'fulfilled'];
    if (!validStatuses.includes(newStatus)) return error(res, 'Invalid status.', HTTP_STATUS.BAD_REQUEST);

    const [rows] = await query('SELECT * FROM qr_orders WHERE id = ? AND restaurant_id = ? LIMIT 1', [id, restaurantId]);
    if (!rows || rows.length === 0) return error(res, 'Order not found.', HTTP_STATUS.NOT_FOUND);
    const qrOrder = rows[0];

    // If accepting, create the real order
    if (newStatus === 'accepted' && qrOrder.status === 'pending') {
      const items = typeof qrOrder.items === 'string' ? JSON.parse(qrOrder.items) : qrOrder.items;

      const orderId = await transaction(async (conn) => {
        const orderNumber = buildOrderNumber();
        let floorId = null;
        if (qrOrder.table_id) {
          const [tbl] = await conn.execute('SELECT floor_id FROM tables WHERE id = ? LIMIT 1', [qrOrder.table_id]);
          floorId = tbl[0]?.floor_id || null;
        }

        // If customer already paid online, mark linked order as paid
        const isPrepaid = qrOrder.payment_preference === 'online' && qrOrder.razorpay_payment_id;
        const [insertRes] = await conn.execute(
          `INSERT INTO orders (restaurant_id, table_id, floor_id, order_number, order_type, status, customer_name, customer_phone, delivery_address, notes, payment_status, payment_mode)
           VALUES (?, ?, ?, ?, ?, 'preparing', ?, ?, ?, ?, ?, ?)`,
          [restaurantId, qrOrder.table_id || null, floorId, orderNumber, qrOrder.order_type || 'dine_in',
            qrOrder.customer_name || null, qrOrder.customer_phone || null,
            qrOrder.delivery_address || null, qrOrder.special_instructions || null,
            isPrepaid ? 'paid' : 'unpaid', isPrepaid ? 'online' : null]
        );
        const newOrderId = insertRes.insertId;

        // Add items
        for (const item of items) {
          const effectiveUnitPrice = item.itemPrice + (item.addonPerUnit || 0);
          const totalPrice = effectiveUnitPrice * item.quantity;
          const taxAmount = (totalPrice * (item.taxRate || 0)) / 100;
          await conn.execute(
            `INSERT INTO order_items (order_id, restaurant_id, menu_item_id, variant_id, item_name, item_price, quantity, tax_rate, tax_amount, total_price, notes, addon_details, addon_per_unit, kot_sent)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
            [newOrderId, restaurantId, item.menuItemId, item.variantId || null, item.itemName,
              item.itemPrice, item.quantity, item.taxRate || 0, taxAmount, totalPrice,
              item.notes || null, item.addonDetails ? JSON.stringify(item.addonDetails) : null, item.addonPerUnit || 0]
          );
        }

        await conn.execute("UPDATE orders SET kot_printed = 1 WHERE id = ?", [newOrderId]);
        await recalcOrder(newOrderId, conn);

        // Update QR order
        await conn.execute("UPDATE qr_orders SET status = 'accepted', accepted_by = ?, linked_order_id = ? WHERE id = ?", [req.user.id, newOrderId, id]);

        return newOrderId;
      });

      return success(res, { orderId }, 'Order accepted and sent to kitchen.');
    }

    // Reject
    if (newStatus === 'rejected') {
      if (qrOrder.status !== 'pending') return error(res, 'Only pending orders can be rejected.', HTTP_STATUS.BAD_REQUEST);
      const { reason, initiateRefund: shouldRefund } = req.body;
      let refundStatus = null;
      if (qrOrder.razorpay_payment_id) {
        // Prepaid order — track whether refund was initiated
        if (shouldRefund) {
          try {
            await initiateRefund(restaurantId, qrOrder.razorpay_payment_id);
            refundStatus = 'refunded';
          } catch (refundErr) {
            console.error('[QR] Auto-refund on reject failed:', refundErr);
            refundStatus = 'not_refunded';
            await query("UPDATE qr_orders SET status = 'rejected', reject_reason = ?, refund_status = ? WHERE id = ?", [reason || null, refundStatus, id]);
            return success(res, null, 'Order rejected but refund failed. Please process refund manually.');
          }
        } else {
          refundStatus = 'not_refunded';
        }
      }
      await query("UPDATE qr_orders SET status = 'rejected', reject_reason = ?, refund_status = ? WHERE id = ?", [reason || null, refundStatus, id]);
      return success(res, null, 'Order rejected.');
    }

    // Fulfill
    if (newStatus === 'fulfilled') {
      if (qrOrder.status !== 'accepted') return error(res, 'Only accepted orders can be fulfilled.', HTTP_STATUS.BAD_REQUEST);
      await query("UPDATE qr_orders SET status = 'fulfilled' WHERE id = ?", [id]);
      if (qrOrder.linked_order_id) {
        await query("UPDATE orders SET status = 'completed', completed_at = NOW() WHERE id = ?", [qrOrder.linked_order_id]);
      }
      return success(res, null, 'Order marked as fulfilled.');
    }

    return error(res, 'Invalid status transition.', HTTP_STATUS.BAD_REQUEST);
  } catch (err) {
    console.error('[QR] updateQROrderStatus error:', err);
    return error(res, 'Failed to update order status.', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
}

// PATCH /api/qr-orders/:id/payment — toggle payment status
async function updateQROrderPayment(req, res) {
  try {
    const { id } = req.params;
    const { paymentStatus } = req.body;
    const restaurantId = req.user.restaurantId;

    if (!['paid', 'unpaid'].includes(paymentStatus)) return error(res, 'Invalid payment status.', HTTP_STATUS.BAD_REQUEST);

    const [rows] = await query('SELECT linked_order_id FROM qr_orders WHERE id = ? AND restaurant_id = ? LIMIT 1', [id, restaurantId]);
    if (!rows || rows.length === 0) return error(res, 'Order not found.', HTTP_STATUS.NOT_FOUND);

    if (rows[0].linked_order_id) {
      await query('UPDATE orders SET payment_status = ?, payment_mode = COALESCE(payment_mode, ?) WHERE id = ?', [paymentStatus, paymentStatus === 'paid' ? 'cash' : null, rows[0].linked_order_id]);
    }

    return success(res, null, `Payment marked as ${paymentStatus}.`);
  } catch (err) {
    console.error('[QR] updateQROrderPayment error:', err);
    return error(res, 'Failed to update payment.', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
}

// POST /api/qr/:restaurantSlug/send-otp — send WhatsApp OTP for phone verification
async function sendPhoneOTP(req, res) {
  try {
    const { restaurantSlug } = req.params;
    const { phone } = req.body;
    if (!phone || phone.replace(/\D/g, '').length < 10) {
      return error(res, 'Valid phone number is required.', HTTP_STATUS.BAD_REQUEST);
    }

    // Look up restaurant and check WA token balance
    const [rRows] = await query('SELECT id, wa_tokens FROM restaurants WHERE slug = ? AND is_active = 1 LIMIT 1', [restaurantSlug]);
    if (!rRows || rRows.length === 0) return error(res, 'Restaurant not found.', HTTP_STATUS.NOT_FOUND);
    const restaurant = rRows[0];

    if (!restaurant.wa_tokens || restaurant.wa_tokens < 1) {
      return error(res, 'Insufficient WA messaging tokens. Please contact the restaurant.', HTTP_STATUS.BAD_REQUEST);
    }

    await requestOTP(phone);

    // Deduct 1 token
    await query('UPDATE restaurants SET wa_tokens = wa_tokens - 1 WHERE id = ? AND wa_tokens > 0', [restaurant.id]);

    // Notify restaurant owner if tokens just ran out
    if (restaurant.wa_tokens === 1) {
      // Was 1 before deduction, now 0
      notifyRestaurantOwner(restaurant.id, 'warning', 'WA Tokens Exhausted', 'Your WhatsApp messaging tokens have run out. Phone verification for customers will be unavailable until tokens are recharged. Please contact support to recharge.');
    }

    return success(res, null, 'OTP sent to your WhatsApp.');
  } catch (err) {
    console.error('[QR] sendPhoneOTP error:', err);
    return error(res, 'Failed to send OTP. Please try again.', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
}

// POST /api/qr/:restaurantSlug/verify-otp — verify WhatsApp OTP
async function verifyPhoneOTP(req, res) {
  try {
    const { phone, otp } = req.body;
    if (!phone || !otp) return error(res, 'Phone and OTP are required.', HTTP_STATUS.BAD_REQUEST);
    const valid = verifyOTP(phone, otp);
    if (!valid) return error(res, 'Invalid or expired OTP.', HTTP_STATUS.BAD_REQUEST);
    return success(res, { verified: true }, 'Phone verified.');
  } catch (err) {
    console.error('[QR] verifyPhoneOTP error:', err);
    return error(res, 'Verification failed.', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
}

module.exports = {
  // Public (POSS model — table-based with PIN)
  getTableInfo,
  verifyTablePin,
  validateSession,
  placeQROrder,
  getQROrderStatus,
  // Public (QR model — no PIN)
  getQRRestaurantInfo,
  getQRFloorsTables,
  getQRTableInfo,
  placeQRModelOrder,
  getQRModelOrderStatus,
  sendPhoneOTP,
  verifyPhoneOTP,
  createQRPayment,
  verifyQRPayment,
  refundQRPayment,
  // Staff (POSS)
  getPendingQROrders,
  getMyPendingQROrders,
  acceptQROrder,
  rejectQROrder,
  // Staff (QR model)
  getQRModelOrders,
  updateQROrderStatus,
  updateQROrderPayment,
  // Table QR management
  generateTableQR,
  resetTableSession,
  downloadTableQR,
};
