'use strict';

const { query, transaction } = require('../config/database');
const { success, error } = require('../utils/responseHelper');
const { HTTP_STATUS } = require('../config/constants');
const { checkFeature } = require('../utils/featureEngine');
const { notifyRestaurantOwner } = require('./notification.controller');
const { buildOrderNumber } = require('../utils/orderHelpers');

async function getReservations(req, res) {
  const { date, status, page = 1, limit = 20 } = req.query;
  const offset = (parseInt(page) - 1) * parseInt(limit);

  let where = 'WHERE r.restaurant_id = ?';
  const params = [req.user.restaurantId];
  if (date) { where += ' AND DATE(r.reservation_date) = ?'; params.push(date); }
  if (status) { where += ' AND r.status = ?'; params.push(status); }

  const [countRows] = await query(`SELECT COUNT(*) AS total FROM reservations r ${where}`, params);
  const [rows] = await query(
    `SELECT r.*, t.table_number, f.name AS floor_name, f.id AS table_floor_id,
            o.order_number, o.status AS order_status, o.payment_status AS order_payment_status
     FROM reservations r
     LEFT JOIN tables t ON t.id = r.table_id
     LEFT JOIN floors f ON f.id = t.floor_id
     LEFT JOIN orders o ON o.id = r.order_id
     ${where}
     ORDER BY r.reservation_date ASC, r.reservation_time ASC
     LIMIT ? OFFSET ?`,
    [...params, parseInt(limit), offset]
  );

  return success(res, { reservations: rows, total: countRows[0].total, page: parseInt(page) });
}

async function getReservationById(req, res) {
  const { reservationId } = req.params;
  const [rows] = await query(
    `SELECT r.*, t.table_number, f.name AS floor_name
     FROM reservations r
     LEFT JOIN tables t ON t.id = r.table_id
     LEFT JOIN floors f ON f.id = t.floor_id
     WHERE r.id = ? AND r.restaurant_id = ? LIMIT 1`,
    [reservationId, req.user.restaurantId]
  );
  if (!rows || rows.length === 0) return error(res, 'Reservation not found.', HTTP_STATUS.NOT_FOUND);
  return success(res, rows[0]);
}

async function createReservation(req, res) {
  const allowed = await checkFeature(req.user.restaurantId, 'feature_reservations');
  if (!allowed) return error(res, 'Reservations feature not available on your plan.', HTTP_STATUS.FORBIDDEN, { upgradeRequired: true });

  const { customerName, customerPhone, customerEmail, guestCount, reservationDate, reservationTime, tableId, notes, advanceAmount, advancePaymentMode } = req.body;
  if (!customerName || !reservationDate || !reservationTime) {
    return error(res, 'customerName, reservationDate and reservationTime are required.', HTTP_STATUS.BAD_REQUEST);
  }

  // Check for table conflicts if tableId provided
  if (tableId) {
    const [conflicts] = await query(
      `SELECT id FROM reservations
       WHERE table_id = ? AND reservation_date = ? AND status NOT IN ('cancelled', 'no_show', 'completed')
         AND ABS(TIMEDIFF(reservation_time, ?) / 10000) < 2`,
      [tableId, reservationDate, reservationTime]
    );
    if (conflicts && conflicts.length > 0) return error(res, 'Table is already reserved at that time.', HTTP_STATUS.CONFLICT);
  }

  const [result] = await query(
    `INSERT INTO reservations (restaurant_id, customer_name, customer_phone, customer_email, guest_count, reservation_date, reservation_time, table_id, notes, advance_amount, advance_payment_mode)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      req.user.restaurantId, customerName, customerPhone || null, customerEmail || null,
      guestCount || 1, reservationDate, reservationTime, tableId || null, notes || null,
      advanceAmount || null, advancePaymentMode || null
    ]
  );

  // Table is NOT marked reserved immediately — it will be auto-marked 2 hours before reservation time
  // via the checkUpcomingReservations polling endpoint

  return success(res, { id: result.insertId }, 'Reservation created.', HTTP_STATUS.CREATED);
}

async function updateReservation(req, res) {
  const { reservationId } = req.params;
  const { customerName, customerPhone, customerEmail, guestCount, reservationDate, reservationTime, tableId, notes, advanceAmount, advancePaymentMode } = req.body;

  const [rows] = await query(
    'SELECT * FROM reservations WHERE id = ? AND restaurant_id = ? LIMIT 1',
    [reservationId, req.user.restaurantId]
  );
  if (!rows || rows.length === 0) return error(res, 'Reservation not found.', HTTP_STATUS.NOT_FOUND);

  await query(
    `UPDATE reservations SET
       customer_name = COALESCE(?, customer_name),
       customer_phone = COALESCE(?, customer_phone),
       customer_email = COALESCE(?, customer_email),
       guest_count = COALESCE(?, guest_count),
       reservation_date = COALESCE(?, reservation_date),
       reservation_time = COALESCE(?, reservation_time),
       table_id = COALESCE(?, table_id),
       notes = COALESCE(?, notes),
       advance_amount = COALESCE(?, advance_amount),
       advance_payment_mode = COALESCE(?, advance_payment_mode)
     WHERE id = ?`,
    [customerName || null, customerPhone || null, customerEmail || null, guestCount || null,
     reservationDate || null, reservationTime || null, tableId || null, notes || null,
     advanceAmount !== undefined ? advanceAmount : null, advancePaymentMode || null, reservationId]
  );
  return success(res, null, 'Reservation updated.');
}

async function updateReservationStatus(req, res) {
  const { reservationId } = req.params;
  const { status } = req.body;
  const validStatuses = ['confirmed', 'seated', 'completed', 'cancelled', 'no_show'];
  if (!validStatuses.includes(status)) return error(res, 'Invalid status.', HTTP_STATUS.BAD_REQUEST);

  const [rows] = await query(
    'SELECT * FROM reservations WHERE id = ? AND restaurant_id = ? LIMIT 1',
    [reservationId, req.user.restaurantId]
  );
  if (!rows || rows.length === 0) return error(res, 'Reservation not found.', HTTP_STATUS.NOT_FOUND);

  await transaction(async (conn) => {
    await conn.execute('UPDATE reservations SET status = ? WHERE id = ?', [status, reservationId]);

    // Free table if cancelled/no_show
    if (['cancelled', 'no_show'].includes(status) && rows[0].table_id) {
      await conn.execute(
        "UPDATE tables SET status = 'available' WHERE id = ? AND restaurant_id = ? AND status = 'reserved'",
        [rows[0].table_id, req.user.restaurantId]
      );
    }
  });

  return success(res, null, 'Reservation status updated.');
}

/* ─── start order from reservation ──────────────────────────────────────────── */

async function startOrderFromReservation(req, res) {
  const { reservationId } = req.params;
  const restaurantId = req.user.restaurantId;

  const [rows] = await query(
    'SELECT * FROM reservations WHERE id = ? AND restaurant_id = ? LIMIT 1',
    [reservationId, restaurantId]
  );
  if (!rows || rows.length === 0) return error(res, 'Reservation not found.', HTTP_STATUS.NOT_FOUND);
  const reservation = rows[0];

  if (reservation.order_id) return error(res, 'An order has already been started for this reservation.', HTTP_STATUS.BAD_REQUEST);
  if (['completed', 'cancelled', 'no_show'].includes(reservation.status)) {
    return error(res, 'Cannot start order for a completed, cancelled, or no-show reservation.', HTTP_STATUS.BAD_REQUEST);
  }

  const tableId = reservation.table_id;

  // Check table availability if assigned (allow 'available' or 'reserved' since reservation owns it)
  if (tableId) {
    const [tableRows] = await query(
      'SELECT * FROM tables WHERE id = ? AND restaurant_id = ? AND is_active = 1 LIMIT 1',
      [tableId, restaurantId]
    );
    if (!tableRows || tableRows.length === 0) return error(res, 'Assigned table not found.', HTTP_STATUS.NOT_FOUND);
    if (tableRows[0].status === 'occupied') return error(res, 'Table is already occupied by another order.', HTTP_STATUS.CONFLICT);
  }

  const orderNumber = buildOrderNumber();
  const result = await transaction(async (conn) => {
    // 1. Create order with customer details from reservation
    const [insertRes] = await conn.execute(
      `INSERT INTO orders (restaurant_id, table_id, order_number, order_type, status, waiter_id, customer_name, customer_phone, notes)
       VALUES (?, ?, ?, 'dine_in', 'pending', ?, ?, ?, ?)`,
      [restaurantId, tableId || null, orderNumber, req.user.id,
       reservation.customer_name, reservation.customer_phone || null,
       reservation.notes ? `Reservation #${reservationId}: ${reservation.notes}` : null]
    );
    const orderId = insertRes.insertId;

    // 2. Mark table as occupied
    if (tableId) {
      await conn.execute(
        'UPDATE tables SET status = ?, current_order_id = ? WHERE id = ? AND restaurant_id = ?',
        ['occupied', orderId, tableId, restaurantId]
      );
    }

    // 3. Link reservation to order and mark seated
    await conn.execute(
      'UPDATE reservations SET order_id = ?, status = ? WHERE id = ?',
      [orderId, 'seated', reservationId]
    );

    // 4. If advance payment was recorded, add it as a payment line
    if (reservation.advance_amount && parseFloat(reservation.advance_amount) > 0) {
      await conn.execute(
        `INSERT INTO payments (order_id, restaurant_id, amount, amount_received, payment_mode, status, processed_by, notes)
         VALUES (?, ?, ?, ?, ?, 'paid', ?, ?)`,
        [orderId, restaurantId, reservation.advance_amount, reservation.advance_amount,
         reservation.advance_payment_mode || 'cash', req.user.id, `Advance against reservation #${reservationId}`]
      );

      // Update order payment status to partial
      await conn.execute(
        "UPDATE orders SET payment_status = 'partial', payment_mode = ? WHERE id = ?",
        [reservation.advance_payment_mode || 'cash', orderId]
      );
    }

    return { id: orderId, orderNumber };
  });

  // Notify (non-blocking)
  notifyRestaurantOwner(
    restaurantId, 'info',
    `New Order: ${result.orderNumber}`,
    `Order started from reservation for ${reservation.customer_name}.`
  ).catch(() => { });

  return success(res, result, 'Order created from reservation.', HTTP_STATUS.CREATED);
}

/* ─── get tables with reservation conflicts for a given date/time ────────── */

async function getAvailableTables(req, res) {
  const { date, time, floorId, excludeReservationId } = req.query;
  const restaurantId = req.user.restaurantId;

  let tableWhere = 'WHERE t.restaurant_id = ? AND t.is_active = 1';
  const tableParams = [restaurantId];
  if (floorId) {
    tableWhere += ' AND t.floor_id = ?';
    tableParams.push(floorId);
  }

  const [tables] = await query(
    `SELECT t.*, f.name AS floor_name
     FROM tables t
     LEFT JOIN floors f ON f.id = t.floor_id
     ${tableWhere}
     ORDER BY f.name ASC, t.table_number ASC`,
    tableParams
  );

  // If date/time provided, check for reservation conflicts
  if (date && time) {
    let conflictWhere = "WHERE r.table_id IS NOT NULL AND r.reservation_date = ? AND r.status NOT IN ('cancelled', 'no_show', 'completed') AND r.restaurant_id = ? AND ABS(TIMEDIFF(r.reservation_time, ?) / 10000) < 2";
    const conflictParams = [date, restaurantId, time];
    if (excludeReservationId) {
      conflictWhere += ' AND r.id != ?';
      conflictParams.push(excludeReservationId);
    }

    const [conflicts] = await query(
      `SELECT r.table_id, r.reservation_time, r.customer_name
       FROM reservations r
       ${conflictWhere}`,
      conflictParams
    );

    const conflictMap = {};
    for (const c of conflicts) {
      conflictMap[c.table_id] = { time: c.reservation_time?.toString().slice(0, 5), customer: c.customer_name };
    }

    const result = tables.map(t => ({
      ...t,
      conflict: conflictMap[t.id] || null,
    }));
    return success(res, result);
  }

  return success(res, tables);
}

/* ─── check upcoming reservations & generate notifications ──────────────── */

async function checkUpcomingReservations(req, res) {
  const restaurantId = req.user.restaurantId;

  // 1. Auto-mark tables as "reserved" for reservations within the next 2 hours
  const [nearbyReservations] = await query(
    `SELECT r.id, r.table_id, r.customer_name, r.reservation_time, r.guest_count, t.table_number, t.status AS table_status, f.name AS floor_name
     FROM reservations r
     LEFT JOIN tables t ON t.id = r.table_id
     LEFT JOIN floors f ON f.id = t.floor_id
     WHERE r.restaurant_id = ?
       AND r.table_id IS NOT NULL
       AND r.status IN ('pending', 'confirmed')
       AND CONCAT(r.reservation_date, ' ', r.reservation_time) BETWEEN NOW() AND DATE_ADD(NOW(), INTERVAL 2 HOUR)`,
    [restaurantId]
  );

  for (const r of nearbyReservations) {
    // Only mark as reserved if table is currently available (don't override occupied)
    if (r.table_status === 'available') {
      await query(
        "UPDATE tables SET status = 'reserved' WHERE id = ? AND restaurant_id = ? AND status = 'available'",
        [r.table_id, restaurantId]
      );
    }
  }

  // 2. Generate 1-hour prior notifications (all reservations, with or without tables)
  const [notifyReservations] = await query(
    `SELECT r.id, r.customer_name, r.reservation_time, r.guest_count, t.table_number
     FROM reservations r
     LEFT JOIN tables t ON t.id = r.table_id
     WHERE r.restaurant_id = ?
       AND r.status IN ('pending', 'confirmed')
       AND CONCAT(r.reservation_date, ' ', r.reservation_time) BETWEEN NOW() AND DATE_ADD(NOW(), INTERVAL 1 HOUR)`,
    [restaurantId]
  );

  for (const r of notifyReservations) {
    const timeStr = r.reservation_time?.toString().slice(0, 5);
    const title = `Upcoming Reservation: ${r.customer_name}`;
    const [existing] = await query(
      `SELECT id FROM notifications WHERE restaurant_id = ? AND title = ? AND DATE(created_at) = CURDATE() LIMIT 1`,
      [restaurantId, title]
    );
    if (!existing || existing.length === 0) {
      const tableInfo = r.table_number ? `Table ${r.table_number}` : 'No table assigned';
      await notifyRestaurantOwner(
        restaurantId, 'info', title,
        `${r.customer_name} (${r.guest_count} guests) at ${timeStr}. ${tableInfo}.`
      );
    }
  }

  return success(res, { upcoming: nearbyReservations.length + notifyReservations.length });
}

async function deleteReservation(req, res) {
  const { reservationId } = req.params;
  const [rows] = await query(
    'SELECT * FROM reservations WHERE id = ? AND restaurant_id = ? LIMIT 1',
    [reservationId, req.user.restaurantId]
  );
  if (!rows || rows.length === 0) return error(res, 'Reservation not found.', HTTP_STATUS.NOT_FOUND);

  if (rows[0].table_id) {
    await query(
      "UPDATE tables SET status = 'available' WHERE id = ? AND restaurant_id = ? AND status = 'reserved'",
      [rows[0].table_id, req.user.restaurantId]
    );
  }
  await query('DELETE FROM reservations WHERE id = ?', [reservationId]);
  return success(res, null, 'Reservation deleted.');
}

module.exports = {
  getReservations, getReservationById, createReservation, updateReservation,
  updateReservationStatus, deleteReservation, startOrderFromReservation,
  getAvailableTables, checkUpcomingReservations,
};
