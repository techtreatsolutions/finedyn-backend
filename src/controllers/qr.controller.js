'use strict';

const crypto = require('crypto');
const QRCode = require('qrcode');
const { query, transaction } = require('../config/database');
const { success, error } = require('../utils/responseHelper');
const { HTTP_STATUS } = require('../config/constants');
const { buildOrderNumber, recalcOrder } = require('../utils/orderHelpers');
const { generateTablePin } = require('../utils/pinHelper');
const { checkFeature } = require('../utils/featureEngine');

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

    return success(res, {
      restaurant: { id: restaurant.id, name: restaurant.name, logoUrl: restaurant.logo_url, currency: restaurant.currency },
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
        if (oRows[0].tax_enabled) {
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
        if (oRows[0].tax_enabled) {
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
        // Create a new order for this table
        const orderNumber = buildOrderNumber();
        const [insertRes] = await conn.execute(
          `INSERT INTO orders (restaurant_id, table_id, order_number, order_type, status, customer_name, customer_phone, notes)
           VALUES (?, ?, ?, 'dine_in', 'pending', ?, ?, ?)`,
          [restaurantId, qrOrder.table_id, orderNumber, qrOrder.customer_name || null, qrOrder.customer_phone || null,
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
    const { reason } = req.body;

    const [rows] = await query(
      "SELECT id FROM qr_orders WHERE id = ? AND restaurant_id = ? AND status = 'pending' LIMIT 1",
      [id, req.user.restaurantId]
    );
    if (!rows || rows.length === 0) return error(res, 'QR order not found or already processed.', HTTP_STATUS.NOT_FOUND);

    await query(
      "UPDATE qr_orders SET status = 'rejected', reject_reason = ? WHERE id = ?",
      [reason || null, id]
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

    // Build permanent QR URL (no session token)
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

module.exports = {
  // Public
  getTableInfo,
  verifyTablePin,
  validateSession,
  placeQROrder,
  getQROrderStatus,
  // Staff
  getPendingQROrders,
  getMyPendingQROrders,
  acceptQROrder,
  rejectQROrder,
  // Table QR management
  generateTableQR,
  resetTableSession,
  downloadTableQR,
};
