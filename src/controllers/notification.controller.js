'use strict';

const { query } = require('../config/database');
const { success, error } = require('../utils/responseHelper');
const { HTTP_STATUS } = require('../config/constants');
const { sendPushToUser, sendPushToAdmins, sendPushToRole, sendPushToRestaurant } = require('../utils/firebase');

/* ── Helper: insert one notification + push ── */
async function notifyUser(userId, type, title, message, restaurantId = null) {
  try {
    await query(
      'INSERT INTO notifications (user_id, type, title, message, restaurant_id) VALUES (?, ?, ?, ?, ?)',
      [userId, type, title, message || null, restaurantId]
    );
    // Also send push notification (non-blocking)
    sendPushToUser(userId, title, message || '', { type, restaurantId: String(restaurantId || '') }).catch(() => {});
  } catch (_) { /* non-critical, never throw */ }
}

/* ── Helper: notify all super_admin users ── */
async function notifySuperAdmins(type, title, message, restaurantId = null) {
  try {
    const [admins] = await query("SELECT id FROM users WHERE role = 'super_admin' AND is_active = 1");
    for (const admin of (admins || [])) {
      await notifyUser(admin.id, type, title, message, restaurantId);
    }
  } catch (_) { /* non-critical */ }
}

/* ── Helper: notify owner of a restaurant ── */
async function notifyRestaurantOwner(restaurantId, type, title, message) {
  try {
    // Insert DB notifications for owners
    const [owners] = await query(
      "SELECT id FROM users WHERE restaurant_id = ? AND role = 'owner' AND is_active = 1",
      [restaurantId]
    );
    for (const owner of (owners || [])) {
      await query(
        'INSERT INTO notifications (user_id, type, title, message, restaurant_id) VALUES (?, ?, ?, ?, ?)',
        [owner.id, type, title, message || null, restaurantId]
      );
    }
    // Send push to all admins (owner + manager) — single push per device
    sendPushToAdmins(restaurantId, title, message || '', { type }).catch(() => {});
  } catch (_) { /* non-critical */ }
}

/* ── Helper: notify kitchen staff of a restaurant (for KOT) ── */
async function notifyKitchenStaff(restaurantId, title, message) {
  try {
    const [staff] = await query(
      "SELECT id FROM users WHERE restaurant_id = ? AND role = 'kitchen_staff' AND is_active = 1",
      [restaurantId]
    );
    for (const s of (staff || [])) {
      await query(
        'INSERT INTO notifications (user_id, type, title, message, restaurant_id) VALUES (?, ?, ?, ?, ?)',
        [s.id, 'order', title, message || null, restaurantId]
      );
    }
    sendPushToRole(restaurantId, 'kitchen_staff', title, message || '', { type: 'kot' }).catch(() => {});
  } catch (_) { /* non-critical */ }
}

/* ── Helper: notify waiters of a restaurant (order ready) ── */
async function notifyWaiters(restaurantId, title, message) {
  try {
    const [waiters] = await query(
      "SELECT id FROM users WHERE restaurant_id = ? AND role = 'waiter' AND is_active = 1",
      [restaurantId]
    );
    for (const w of (waiters || [])) {
      await query(
        'INSERT INTO notifications (user_id, type, title, message, restaurant_id) VALUES (?, ?, ?, ?, ?)',
        [w.id, 'order', title, message || null, restaurantId]
      );
    }
    sendPushToRole(restaurantId, 'waiter', title, message || '', { type: 'order_ready' }).catch(() => {});
  } catch (_) { /* non-critical */ }
}

/* ── Auto-generate expiry notifications (lazy) ── */
async function autoGenerateExpiryAlerts(userId, role, restaurantId) {
  try {
    if (role === 'owner' && restaurantId) {
      // Check if owner's restaurant is expiring in ≤10 days
      const [restRows] = await query(
        `SELECT id, name, subscription_end, DATEDIFF(subscription_end, NOW()) AS days_left
         FROM restaurants WHERE id = ? AND subscription_status = 'active'
         AND subscription_end BETWEEN NOW() AND DATE_ADD(NOW(), INTERVAL 10 DAY) LIMIT 1`,
        [restaurantId]
      );
      if (restRows && restRows.length > 0) {
        const r = restRows[0];
        // Check if we already created this alert today
        const [existing] = await query(
          `SELECT id FROM notifications WHERE user_id = ? AND restaurant_id = ?
           AND title LIKE 'Subscription Expiring%' AND DATE(created_at) = CURDATE() LIMIT 1`,
          [userId, restaurantId]
        );
        if (!existing || existing.length === 0) {
          await notifyUser(
            userId, 'warning',
            `Subscription Expiring in ${r.days_left} day(s)`,
            `Your FineDyn subscription expires on ${new Date(r.subscription_end).toLocaleDateString('en-IN')}. Please renew to avoid service interruption.`,
            restaurantId
          );
        }
      }
    } else if (role === 'super_admin') {
      // Check all restaurants expiring in ≤10 days
      const [expiring] = await query(
        `SELECT r.id, r.name, r.subscription_end, DATEDIFF(r.subscription_end, NOW()) AS days_left
         FROM restaurants r
         WHERE r.subscription_status = 'active'
         AND r.subscription_end BETWEEN NOW() AND DATE_ADD(NOW(), INTERVAL 10 DAY)`
      );
      for (const r of (expiring || [])) {
        const [existing] = await query(
          `SELECT id FROM notifications WHERE user_id = ? AND restaurant_id = ?
           AND title LIKE 'Restaurant Subscription Expiring%' AND DATE(created_at) = CURDATE() LIMIT 1`,
          [userId, r.id]
        );
        if (!existing || existing.length === 0) {
          await notifyUser(
            userId, 'warning',
            `Restaurant Subscription Expiring: ${r.name}`,
            `${r.name}'s subscription expires in ${r.days_left} day(s) on ${new Date(r.subscription_end).toLocaleDateString('en-IN')}.`,
            r.id
          );
        }
      }
    }
  } catch (_) { /* non-critical */ }
}

/* ── GET /api/notifications ── */
async function getNotifications(req, res) {
  const userId = req.user.id;
  const role = req.user.role;
  const restaurantId = req.user.restaurantId;

  // Auto-generate expiry alerts lazily
  await autoGenerateExpiryAlerts(userId, role, restaurantId);

  // Super admins see all their notifications; restaurant staff only see notifications for their restaurant (or with no restaurant)
  let whereClause, queryParams;
  if (role === 'super_admin') {
    whereClause = 'WHERE n.user_id = ?';
    queryParams = [userId];
  } else {
    whereClause = 'WHERE n.user_id = ? AND (n.restaurant_id = ? OR n.restaurant_id IS NULL)';
    queryParams = [userId, restaurantId];
  }

  const [notifications] = await query(
    `SELECT n.*, r.name AS restaurant_name
     FROM notifications n
     LEFT JOIN restaurants r ON r.id = n.restaurant_id
     ${whereClause}
     ORDER BY n.created_at DESC LIMIT 30`,
    queryParams
  );

  const [countRow] = await query(
    `SELECT COUNT(*) AS unreadCount FROM notifications n ${whereClause} AND n.is_read = 0`,
    queryParams
  );

  return success(res, {
    notifications: notifications || [],
    unreadCount: countRow?.[0]?.unreadCount || 0,
  });
}

/* ── PUT /api/notifications/:id/read ── */
async function markRead(req, res) {
  const { id } = req.params;
  await query('UPDATE notifications SET is_read = 1 WHERE id = ? AND user_id = ?', [id, req.user.id]);
  return success(res, null, 'Notification marked as read.');
}

/* ── PUT /api/notifications/read-all ── */
async function markAllRead(req, res) {
  await query('UPDATE notifications SET is_read = 1 WHERE user_id = ?', [req.user.id]);
  return success(res, null, 'All notifications marked as read.');
}

module.exports = {
  getNotifications,
  markRead,
  markAllRead,
  notifyUser,
  notifySuperAdmins,
  notifyRestaurantOwner,
  notifyKitchenStaff,
  notifyWaiters,
};
