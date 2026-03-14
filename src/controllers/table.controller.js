'use strict';

const { query } = require('../config/database');
const { success, error } = require('../utils/responseHelper');
const { HTTP_STATUS } = require('../config/constants');
const { checkLimit, checkFeature } = require('../utils/featureEngine');
const { generateTablePin } = require('../utils/pinHelper');

async function getTables(req, res) {
  const { floorId } = req.query;
  let where = 'WHERE t.restaurant_id = ? AND t.is_active = 1';
  const params = [req.user.restaurantId];
  if (floorId) { where += ' AND t.floor_id = ?'; params.push(floorId); }

  const [rows] = await query(
    `SELECT t.*, f.name AS floor_name,
            u.name AS waiter_name,
            o.id AS order_id, o.order_number, o.total_amount AS order_total, o.status AS order_status, o.created_at AS order_started_at
     FROM tables t
     LEFT JOIN floors f ON f.id = t.floor_id
     LEFT JOIN users u ON u.id = t.assigned_waiter_id
     LEFT JOIN orders o ON o.id = t.current_order_id
     ${where} ORDER BY t.table_number ASC`,
    params
  );
  return success(res, rows);
}

async function getTableById(req, res) {
  const { tableId } = req.params;
  const [rows] = await query(
    `SELECT t.*, f.name AS floor_name, u.name AS waiter_name
     FROM tables t LEFT JOIN floors f ON f.id = t.floor_id LEFT JOIN users u ON u.id = t.assigned_waiter_id
     WHERE t.id = ? AND t.restaurant_id = ? LIMIT 1`,
    [tableId, req.user.restaurantId]
  );
  if (!rows || rows.length === 0) return error(res, 'Table not found.', HTTP_STATUS.NOT_FOUND);

  let currentOrder = null;
  if (rows[0].current_order_id) {
    const [orderRows] = await query(
      `SELECT o.*, JSON_ARRAYAGG(JSON_OBJECT('id', oi.id, 'item_name', oi.item_name, 'quantity', oi.quantity, 'total_price', oi.total_price, 'status', oi.status)) AS items
       FROM orders o LEFT JOIN order_items oi ON oi.order_id = o.id
       WHERE o.id = ? GROUP BY o.id LIMIT 1`,
      [rows[0].current_order_id]
    );
    currentOrder = orderRows[0] || null;
  }
  return success(res, { ...rows[0], currentOrder });
}

async function createTable(req, res) {
  const { floorId, tableNumber, capacity, shape } = req.body;
  if (!tableNumber) return error(res, 'tableNumber is required.', HTTP_STATUS.BAD_REQUEST);

  const [countRows] = await query('SELECT COUNT(*) AS count FROM tables WHERE restaurant_id = ? AND is_active = 1', [req.user.restaurantId]);
  const limitCheck = await checkLimit(req.user.restaurantId, 'max_tables', countRows[0].count);
  if (!limitCheck.allowed) return error(res, `Table limit reached (${limitCheck.limit}). Upgrade your plan.`, HTTP_STATUS.FORBIDDEN, { upgradeRequired: true });

  const [existing] = await query(
    'SELECT id FROM tables WHERE restaurant_id = ? AND floor_id <=> ? AND table_number = ? AND is_active = 1',
    [req.user.restaurantId, floorId || null, tableNumber]
  );
  if (existing && existing.length > 0) return error(res, 'Table number already exists on this floor.', HTTP_STATUS.CONFLICT);

  const edineEnabled = await checkFeature(req.user.restaurantId, 'feature_edine_in_orders');
  const pin = edineEnabled ? generateTablePin() : null;
  const [result] = await query(
    'INSERT INTO tables (restaurant_id, floor_id, table_number, capacity, shape, table_pin) VALUES (?, ?, ?, ?, ?, ?)',
    [req.user.restaurantId, floorId || null, tableNumber, capacity || 4, shape || 'square', pin]
  );
  return success(res, { id: result.insertId }, 'Table created.', HTTP_STATUS.CREATED);
}

async function updateTable(req, res) {
  const { tableId } = req.params;
  const { tableNumber, capacity, shape, floorId } = req.body;
  await query(
    'UPDATE tables SET table_number = COALESCE(?, table_number), capacity = COALESCE(?, capacity), shape = COALESCE(?, shape), floor_id = COALESCE(?, floor_id) WHERE id = ? AND restaurant_id = ?',
    [tableNumber || null, capacity || null, shape || null, floorId || null, tableId, req.user.restaurantId]
  );
  return success(res, null, 'Table updated.');
}

async function deleteTable(req, res) {
  const { tableId } = req.params;
  const [rows] = await query('SELECT status FROM tables WHERE id = ? AND restaurant_id = ? LIMIT 1', [tableId, req.user.restaurantId]);
  if (!rows || rows.length === 0) return error(res, 'Table not found.', HTTP_STATUS.NOT_FOUND);
  if (rows[0].status === 'occupied') return error(res, 'Cannot delete an occupied table.', HTTP_STATUS.BAD_REQUEST);
  await query('UPDATE tables SET is_active = 0 WHERE id = ? AND restaurant_id = ?', [tableId, req.user.restaurantId]);
  return success(res, null, 'Table deleted.');
}

async function assignWaiter(req, res) {
  const { tableId } = req.params;
  const { waiterId } = req.body;

  if (waiterId) {
    const [waiterRows] = await query('SELECT id FROM users WHERE id = ? AND restaurant_id = ? AND role = ? AND is_active = 1 LIMIT 1', [waiterId, req.user.restaurantId, 'waiter']);
    if (!waiterRows || waiterRows.length === 0) return error(res, 'Waiter not found.', HTTP_STATUS.NOT_FOUND);
  }

  await query('UPDATE tables SET assigned_waiter_id = ? WHERE id = ? AND restaurant_id = ?', [waiterId || null, tableId, req.user.restaurantId]);
  return success(res, null, waiterId ? 'Waiter assigned.' : 'Waiter removed.');
}

async function updateTableStatus(req, res) {
  const { tableId } = req.params;
  const { status } = req.body;
  const validStatuses = ['available', 'occupied', 'reserved', 'cleaning'];
  if (!validStatuses.includes(status)) return error(res, 'Invalid status.', HTTP_STATUS.BAD_REQUEST);

  // Block manual status changes on reserved tables (must be done via reservation flow)
  const [tableRows] = await query('SELECT status FROM tables WHERE id = ? AND restaurant_id = ? LIMIT 1', [tableId, req.user.restaurantId]);
  if (tableRows && tableRows.length > 0 && tableRows[0].status === 'reserved') {
    return error(res, 'This table is reserved for an upcoming reservation. Cancel the reservation first to change the status.', HTTP_STATUS.BAD_REQUEST);
  }

  await query('UPDATE tables SET status = ? WHERE id = ? AND restaurant_id = ?', [status, tableId, req.user.restaurantId]);
  // Deactivate QR session and regenerate PIN when table status changes away from occupied
  if (status !== 'occupied') {
    await query('UPDATE qr_sessions SET is_active = 0 WHERE table_id = ? AND restaurant_id = ? AND is_active = 1', [tableId, req.user.restaurantId]);
    const edineOn = await checkFeature(req.user.restaurantId, 'feature_edine_in_orders');
    if (edineOn) {
      const newPin = generateTablePin();
      await query('UPDATE tables SET table_pin = ? WHERE id = ? AND restaurant_id = ?', [newPin, tableId, req.user.restaurantId]);
    }
  }
  return success(res, null, 'Table status updated.');
}

async function getTableMapForFloor(req, res) {
  const { floorId } = req.params;
  const restaurantId = req.user.restaurantId;
  const [rows] = await query(
    `SELECT t.*, u.name AS waiter_name,
            o.order_number, o.total_amount AS order_total, o.status AS order_status,
            TIMESTAMPDIFF(MINUTE, o.created_at, NOW()) AS minutes_occupied
     FROM tables t
     LEFT JOIN users u ON u.id = t.assigned_waiter_id
     LEFT JOIN orders o ON o.id = t.current_order_id
     WHERE t.floor_id = ? AND t.restaurant_id = ? AND t.is_active = 1
     ORDER BY t.table_number ASC`,
    [floorId, restaurantId]
  );

  // For reserved tables, attach active reservation info
  const reservedTableIds = rows.filter(t => t.status === 'reserved').map(t => t.id);
  if (reservedTableIds.length > 0) {
    const placeholders = reservedTableIds.map(() => '?').join(',');
    const [reservations] = await query(
      `SELECT r.id AS reservation_id, r.table_id, r.customer_name AS reservation_customer,
              r.customer_phone AS reservation_phone, r.guest_count AS reservation_guests,
              r.reservation_time, r.notes AS reservation_notes,
              r.advance_amount AS reservation_advance, r.advance_payment_mode AS reservation_advance_mode
       FROM reservations r
       WHERE r.table_id IN (${placeholders}) AND r.restaurant_id = ?
         AND r.status IN ('pending', 'confirmed')
         AND CONCAT(r.reservation_date, ' ', r.reservation_time) >= NOW()
       ORDER BY CONCAT(r.reservation_date, ' ', r.reservation_time) ASC`,
      [...reservedTableIds, restaurantId]
    );

    const resMap = {};
    for (const r of reservations) {
      if (!resMap[r.table_id]) resMap[r.table_id] = r;
    }

    for (const row of rows) {
      if (resMap[row.id]) {
        Object.assign(row, resMap[row.id]);
      }
    }
  }

  return success(res, rows);
}

async function getWaiters(req, res) {
  const [rows] = await query(
    'SELECT id, name FROM users WHERE restaurant_id = ? AND role = ? AND is_active = 1 ORDER BY name ASC',
    [req.user.restaurantId, 'waiter']
  );
  return success(res, rows);
}

async function getMyTables(req, res) {
  const waiterId = req.user.id;
  const restaurantId = req.user.restaurantId;

  const [rows] = await query(
    `SELECT t.*, f.name AS floor_name,
            o.id AS order_id, o.order_number, o.total_amount AS order_total, o.status AS order_status, o.created_at AS order_started_at,
            TIMESTAMPDIFF(MINUTE, o.created_at, NOW()) AS minutes_occupied
     FROM tables t
     LEFT JOIN floors f ON f.id = t.floor_id
     LEFT JOIN orders o ON o.id = t.current_order_id
     WHERE t.restaurant_id = ? AND t.is_active = 1 AND t.assigned_waiter_id = ?
     ORDER BY f.name ASC, t.table_number ASC`,
    [restaurantId, waiterId]
  );
  return success(res, rows);
}

async function waiterResetSession(req, res) {
  const { tableId } = req.params;
  const restaurantId = req.user.restaurantId;
  const waiterId = req.user.id;

  // Verify table is assigned to this waiter
  const [tRows] = await query(
    'SELECT id FROM tables WHERE id = ? AND restaurant_id = ? AND assigned_waiter_id = ? AND is_active = 1 LIMIT 1',
    [tableId, restaurantId, waiterId]
  );
  if (!tRows || tRows.length === 0) return error(res, 'Table not found or not assigned to you.', HTTP_STATUS.FORBIDDEN);

  // Deactivate all sessions
  await query('UPDATE qr_sessions SET is_active = 0 WHERE table_id = ? AND restaurant_id = ?', [tableId, restaurantId]);

  // Reject pending QR orders
  await query(
    "UPDATE qr_orders SET status = 'expired' WHERE table_id = ? AND restaurant_id = ? AND status = 'pending'",
    [tableId, restaurantId]
  );

  // Regenerate PIN if e-dine-in is enabled
  const edineOn = await checkFeature(restaurantId, 'feature_edine_in_orders');
  let newPin = null;
  if (edineOn) {
    newPin = generateTablePin();
    await query('UPDATE tables SET table_pin = ? WHERE id = ? AND restaurant_id = ?', [newPin, tableId, restaurantId]);
  }

  return success(res, { pin: newPin }, 'Session & PIN reset.');
}

module.exports = { getTables, getTableById, createTable, updateTable, deleteTable, assignWaiter, updateTableStatus, getTableMapForFloor, getWaiters, getMyTables, waiterResetSession };
