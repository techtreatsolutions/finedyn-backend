'use strict';

const bcrypt = require('bcryptjs');
const { query, transaction } = require('../config/database');
const { success, error, paginate } = require('../utils/responseHelper');
const { HTTP_STATUS, ROLES } = require('../config/constants');
const { sendWelcome } = require('../utils/email');
const { notifySuperAdmins } = require('./notification.controller');

async function getDashboard(req, res) {
  const [statsRows] = await query(`
    SELECT
      (SELECT COUNT(*) FROM restaurants WHERE is_active = 1) AS totalRestaurants,
      (SELECT COUNT(*) FROM restaurants WHERE subscription_status = 'active') AS activeRestaurants,
      (SELECT COUNT(*) FROM restaurants WHERE subscription_status = 'trial') AS trialRestaurants,
      (SELECT COUNT(*) FROM restaurants WHERE subscription_status = 'expired') AS expiredRestaurants,
      (SELECT COUNT(*) FROM users WHERE role != 'super_admin') AS totalUsers,
      (SELECT COALESCE(SUM(sp.amount / sp.duration_months), 0)
         FROM subscription_payments sp
         JOIN restaurants r ON r.id = sp.restaurant_id
         WHERE r.subscription_status IN ('active','trial')
           AND sp.id = (SELECT MAX(sp2.id) FROM subscription_payments sp2 WHERE sp2.restaurant_id = sp.restaurant_id)) AS mrr,
      (SELECT COALESCE(SUM(amount), 0) FROM subscription_payments
         WHERE MONTH(created_at) = MONTH(NOW()) AND YEAR(created_at) = YEAR(NOW())) AS revenueThisMonth,
      (SELECT COALESCE(SUM(amount), 0) FROM subscription_payments) AS totalRevenue
  `);

  const [planDist] = await query(`
    SELECT p.name, COUNT(r.id) AS count, p.price_monthly AS priceMonthly
    FROM plans p LEFT JOIN restaurants r ON r.plan_id = p.id AND r.is_active = 1
    GROUP BY p.id, p.name, p.price_monthly ORDER BY count DESC
  `);

  const [recentRestaurants] = await query(`
    SELECT r.id, r.name, r.type, r.city, r.subscription_status, r.created_at,
           p.name AS plan_name, u.name AS owner_name, u.email AS owner_email
    FROM restaurants r
    LEFT JOIN plans p ON p.id = r.plan_id
    LEFT JOIN users u ON u.restaurant_id = r.id AND u.role = 'owner'
    WHERE r.created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)
    ORDER BY r.created_at DESC LIMIT 20
  `);

  const [expiringSoon] = await query(`
    SELECT r.id, r.name, r.city, r.subscription_end,
           DATEDIFF(r.subscription_end, NOW()) AS days_left,
           p.name AS plan_name, p.price_monthly
    FROM restaurants r
    LEFT JOIN plans p ON p.id = r.plan_id
    WHERE r.subscription_status = 'active'
      AND r.subscription_end BETWEEN NOW() AND DATE_ADD(NOW(), INTERVAL 10 DAY)
    ORDER BY r.subscription_end ASC
  `);

  return success(res, {
    stats: statsRows[0],
    planDistribution: planDist,
    recentRestaurants,
    expiringSoon,
  });
}

async function getRestaurantStats(req, res) {
  const { id } = req.params;
  const [rows] = await query(
    `SELECT
      (SELECT COUNT(*) FROM orders WHERE restaurant_id = ? AND created_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)) * 4 AS avgMonthlyOrders,
      (SELECT COALESCE(SUM(total_amount), 0) FROM orders WHERE restaurant_id = ? AND created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY) AND payment_status = 'paid') AS revenue30d,
      (SELECT COUNT(*) FROM orders WHERE restaurant_id = ? AND created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)) AS bills30d,
      (SELECT COUNT(*) FROM menu_items WHERE restaurant_id = ? AND is_available = 1) AS menuItemsCount,
      (SELECT COUNT(*) FROM users WHERE restaurant_id = ? AND is_active = 1) AS staffCount,
      p.name AS planName, p.price_monthly AS planMonthlyPrice
     FROM restaurants r LEFT JOIN plans p ON p.id = r.plan_id WHERE r.id = ? LIMIT 1`,
    [id, id, id, id, id, id]
  );
  if (!rows || rows.length === 0) return error(res, 'Restaurant not found.', HTTP_STATUS.NOT_FOUND);
  return success(res, rows[0]);
}

async function getAllRestaurants(req, res) {
  const { page, limit, search, status, planId } = req.query;
  const parsedPage = parseInt(page) || 1;
  const parsedLimit = parseInt(limit) || 20;
  const offset = (parsedPage - 1) * parsedLimit;

  let where = 'WHERE 1=1';
  const params = [];

  if (search) { where += ' AND (r.name LIKE ? OR r.email LIKE ? OR u.name LIKE ?)'; params.push(`%${search}%`, `%${search}%`, `%${search}%`); }
  if (status) { where += ' AND r.subscription_status = ?'; params.push(status); }
  if (planId) { where += ' AND r.plan_id = ?'; params.push(planId); }

  const [countRows] = await query(
    `SELECT COUNT(*) AS total FROM restaurants r LEFT JOIN users u ON u.restaurant_id = r.id AND u.role = 'owner' ${where}`,
    params
  );
  const total = countRows[0].total;

  const [rows] = await query(
    `SELECT r.id, r.name, r.slug, r.type, r.email, r.phone, r.city, r.subscription_status,
            r.subscription_start, r.subscription_end, r.is_active, r.created_at,
            r.plan_id,
            p.name AS plan_name,
            u.name AS owner_name, u.email AS owner_email
     FROM restaurants r
     LEFT JOIN plans p ON p.id = r.plan_id
     LEFT JOIN users u ON u.restaurant_id = r.id AND u.role = 'owner'
     ${where} ORDER BY r.created_at DESC LIMIT ? OFFSET ?`,
    [...params, parsedLimit, offset]
  );

  return paginate(res, rows, total, parsedPage, parsedLimit);
}

async function getRestaurantById(req, res) {
  const { id } = req.params;
  const [rows] = await query(
    `SELECT r.*, p.name AS plan_name, p.price_monthly, u.name AS owner_name, u.email AS owner_email, u.phone AS owner_phone
     FROM restaurants r LEFT JOIN plans p ON p.id = r.plan_id
     LEFT JOIN users u ON u.restaurant_id = r.id AND u.role = 'owner'
     WHERE r.id = ? LIMIT 1`,
    [id]
  );
  if (!rows || rows.length === 0) return error(res, 'Restaurant not found.', HTTP_STATUS.NOT_FOUND);

  const [staff] = await query('SELECT id, name, email, role, is_active, last_login FROM users WHERE restaurant_id = ? ORDER BY role, name', [id]);
  const [subHistory] = await query('SELECT sp.*, p.name AS plan_name, u.name AS processed_by_name FROM subscription_payments sp LEFT JOIN plans p ON p.id = sp.plan_id LEFT JOIN users u ON u.id = sp.processed_by WHERE sp.restaurant_id = ? ORDER BY sp.created_at DESC LIMIT 20', [id]);
  const [overrides] = await query('SELECT * FROM feature_overrides WHERE restaurant_id = ?', [id]);

  // Stats
  const [statsRows] = await query(`
    SELECT
      (SELECT COUNT(*) FROM orders WHERE restaurant_id = ? AND DATE(created_at) = CURDATE()) AS orders_today,
      (SELECT COALESCE(SUM(total_amount), 0) FROM orders WHERE restaurant_id = ? AND DATE(created_at) = CURDATE() AND payment_status = 'paid') AS revenue_today,
      (SELECT COUNT(*) FROM users WHERE restaurant_id = ? AND is_active = 1) AS staff_count
  `, [id, id, id]);

  return success(res, { restaurant: rows[0], staff, subscriptionHistory: subHistory, featureOverrides: overrides, stats: statsRows[0] });
}

async function createRestaurant(req, res) {
  const { restaurantName, restaurantType, ownerName, email, phone, address, city, state, planId, password } = req.body;
  if (!restaurantName || !ownerName || !email) return error(res, 'Required: restaurantName, ownerName, email.', HTTP_STATUS.BAD_REQUEST);

  const [existing] = await query('SELECT id FROM users WHERE email = ? LIMIT 1', [email.trim()]);
  if (existing && existing.length > 0) return error(res, 'Email already in use.', HTTP_STATUS.CONFLICT);

  const finalPassword = password || 'FineDyn@123';

  const result = await transaction(async (conn) => {
    const slug = restaurantName.toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-') + '-' + Date.now();
    const [restResult] = await conn.execute(
      `INSERT INTO restaurants (name, slug, type, email, phone, address, city, state, plan_id, subscription_status, subscription_start, subscription_end)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'trial', NOW(), DATE_ADD(NOW(), INTERVAL 14 DAY))`,
      [restaurantName.trim(), slug, restaurantType || 'dine_in', email.trim(), phone || null, address || null, city || null, state || null, planId || 1]
    );
    const restaurantId = restResult.insertId;
    const hash = await bcrypt.hash(finalPassword, 12);
    const [userResult] = await conn.execute(
      'INSERT INTO users (restaurant_id, name, email, phone, password_hash, role, is_active, is_verified) VALUES (?, ?, ?, ?, ?, ?, 1, 1)',
      [restaurantId, ownerName.trim(), email.trim(), phone || null, hash, ROLES.OWNER]
    );
    await conn.execute('INSERT INTO bill_format_settings (restaurant_id) VALUES (?)', [restaurantId]);
    return { restaurantId, userId: userResult.insertId };
  });

  sendWelcome(email, ownerName, restaurantName).catch(() => { });
  notifySuperAdmins('info', `New Restaurant Added: ${restaurantName}`, `${restaurantName} (owner: ${ownerName}, ${email}) was added by super admin.`, result.restaurantId).catch(() => { });
  return success(res, { ...result, tempPassword: finalPassword }, 'Restaurant created.', HTTP_STATUS.CREATED);
}

async function updateRestaurant(req, res) {
  const { id } = req.params;
  const { name, type, phone, address, city, state, planId } = req.body;

  await query(
    'UPDATE restaurants SET name = COALESCE(?, name), type = COALESCE(?, type), phone = COALESCE(?, phone), address = COALESCE(?, address), city = COALESCE(?, city), state = COALESCE(?, state), plan_id = COALESCE(?, plan_id) WHERE id = ?',
    [name || null, type || null, phone || null, address || null, city || null, state || null, planId || null, id]
  );
  return success(res, null, 'Restaurant updated.');
}

async function toggleRestaurantStatus(req, res) {
  const { id } = req.params;
  const { isActive, suspendReason } = req.body;
  const status = isActive ? 'active' : 'suspended';
  await query('UPDATE restaurants SET is_active = ?, subscription_status = ? WHERE id = ?', [isActive ? 1 : 0, status, id]);
  return success(res, null, `Restaurant ${isActive ? 'activated' : 'suspended'}.`);
}

async function renewSubscription(req, res) {
  const { id } = req.params;
  const { planId, durationMonths, amount, paymentMode, remarks, featureOverrides } = req.body;
  if (!planId || !durationMonths || !amount) return error(res, 'planId, durationMonths and amount are required.', HTTP_STATUS.BAD_REQUEST);

  const [nameRow] = await query('SELECT name FROM restaurants WHERE id = ? LIMIT 1', [id]);
  const restaurantName = nameRow?.[0]?.name || `Restaurant #${id}`;

  await transaction(async (conn) => {
    const [restRows] = await conn.execute('SELECT subscription_end, subscription_status FROM restaurants WHERE id = ? LIMIT 1', [id]);
    if (!restRows || restRows.length === 0) throw new Error('Restaurant not found');

    const now = new Date();
    let startDate = now;
    if (restRows[0].subscription_status === 'active' && new Date(restRows[0].subscription_end) > now) {
      startDate = new Date(restRows[0].subscription_end);
    }
    const endDate = new Date(startDate);
    endDate.setMonth(endDate.getMonth() + parseInt(durationMonths));

    await conn.execute(
      "UPDATE restaurants SET plan_id = ?, subscription_status = 'active', subscription_start = ?, subscription_end = ? WHERE id = ?",
      [planId, startDate, endDate, id]
    );
    await conn.execute(
      'INSERT INTO subscription_payments (restaurant_id, plan_id, amount, payment_mode, duration_months, remarks, subscription_start, subscription_end, processed_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [id, planId, amount, paymentMode || 'cash', durationMonths, remarks || null, startDate, endDate, req.user.id]
    );

    // Apply per-restaurant feature overrides if provided
    if (featureOverrides && Array.isArray(featureOverrides)) {
      const featureNames = featureOverrides.map(fo => fo.featureName).filter(Boolean);
      if (featureNames.length > 0) {
        await conn.execute(
          `DELETE FROM feature_overrides WHERE restaurant_id = ? AND feature_name IN (${featureNames.map(() => '?').join(',')})`,
          [id, ...featureNames]
        );
      }
      const [planDetail] = await conn.execute('SELECT * FROM plans WHERE id = ? LIMIT 1', [planId]);
      const plan = planDetail[0] || {};
      for (const fo of featureOverrides) {
        if (!fo.featureName) continue;
        const overrideVal = String(fo.overrideValue);
        const planBool = plan[fo.featureName] === 1 || plan[fo.featureName] === true;
        const overrideBool = overrideVal === '1' || overrideVal === 'true';
        if (overrideBool !== planBool) {
          await conn.execute(
            'INSERT INTO feature_overrides (restaurant_id, feature_name, override_value, overridden_by) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE override_value = ?, overridden_by = ?',
            [id, fo.featureName, overrideVal, req.user.id, overrideVal, req.user.id]
          );
        }
      }
    }
  });

  // Notify all super admins about the renewal
  notifySuperAdmins(
    'success',
    `Subscription Renewed: ${restaurantName}`,
    `Subscription renewed for ${durationMonths} month(s). Amount: ₹${amount}. Payment mode: ${paymentMode || 'cash'}.`,
    parseInt(id)
  ).catch(() => { });

  // Notify the restaurant owner
  const { notifyRestaurantOwner } = require('./notification.controller');
  notifyRestaurantOwner(
    parseInt(id), 'success',
    'Subscription Renewed',
    `Your FineDyn subscription has been renewed for ${durationMonths} month(s). Thank you!`
  ).catch(() => { });

  return success(res, null, 'Subscription renewed successfully.');
}

async function updateCurrentPlan(req, res) {
  const { id } = req.params;
  const { planId, featureOverrides } = req.body;
  if (!planId) return error(res, 'planId is required.', HTTP_STATUS.BAD_REQUEST);

  const [restRows] = await query('SELECT id, name FROM restaurants WHERE id = ? LIMIT 1', [id]);
  if (!restRows || restRows.length === 0) return error(res, 'Restaurant not found.', HTTP_STATUS.NOT_FOUND);

  const [planRows] = await query('SELECT id, name FROM plans WHERE id = ? AND is_active = 1 LIMIT 1', [planId]);
  if (!planRows || planRows.length === 0) return error(res, 'Plan not found.', HTTP_STATUS.NOT_FOUND);

  await transaction(async (conn) => {
    await conn.execute('UPDATE restaurants SET plan_id = ? WHERE id = ?', [planId, id]);

    if (featureOverrides && Array.isArray(featureOverrides)) {
      // Clear all existing boolean feature overrides for this restaurant, then re-insert
      const featureNames = featureOverrides.map(fo => fo.featureName).filter(Boolean);
      if (featureNames.length > 0) {
        await conn.execute(
          `DELETE FROM feature_overrides WHERE restaurant_id = ? AND feature_name IN (${featureNames.map(() => '?').join(',')})`,
          [id, ...featureNames]
        );
      }
      // Only insert overrides that differ from the plan defaults
      const [planDetail] = await conn.execute('SELECT * FROM plans WHERE id = ? LIMIT 1', [planId]);
      const plan = planDetail[0] || {};
      for (const fo of featureOverrides) {
        if (!fo.featureName) continue;
        const overrideVal = String(fo.overrideValue);
        const planVal = plan[fo.featureName];
        const planBool = planVal === 1 || planVal === true;
        const overrideBool = overrideVal === '1' || overrideVal === 'true';
        // Only store override if it differs from plan default
        if (overrideBool !== planBool) {
          await conn.execute(
            'INSERT INTO feature_overrides (restaurant_id, feature_name, override_value, overridden_by) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE override_value = ?, overridden_by = ?',
            [id, fo.featureName, overrideVal, req.user.id, overrideVal, req.user.id]
          );
        }
      }
    }
  });

  notifySuperAdmins(
    'info',
    `Plan Updated: ${restRows[0].name}`,
    `Plan changed to "${planRows[0].name}" (applied to current subscription, no renewal).`,
    parseInt(id)
  ).catch(() => { });

  return success(res, null, `Plan updated to "${planRows[0].name}" on current subscription.`);
}

async function overrideFeature(req, res) {
  const { id } = req.params;
  const { featureName, overrideValue } = req.body;
  if (!featureName || overrideValue === undefined) return error(res, 'featureName and overrideValue are required.', HTTP_STATUS.BAD_REQUEST);

  await query(
    'INSERT INTO feature_overrides (restaurant_id, feature_name, override_value, overridden_by) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE override_value = ?, overridden_by = ?',
    [id, featureName, String(overrideValue), req.user.id, String(overrideValue), req.user.id]
  );
  return success(res, null, 'Feature override applied.');
}

async function removeOverride(req, res) {
  const { id } = req.params;
  // Support both URL param (:featureName) and POST body (featureName / featureKey)
  const featureName = req.params.featureName || req.body.featureName || req.body.featureKey;
  if (!featureName) return error(res, 'featureName is required.', HTTP_STATUS.BAD_REQUEST);
  await query('DELETE FROM feature_overrides WHERE restaurant_id = ? AND feature_name = ?', [id, featureName]);
  return success(res, null, 'Override removed.');
}

async function getAllPlans(req, res) {
  const [rows] = await query('SELECT * FROM plans ORDER BY sort_order ASC');
  return success(res, rows);
}

async function createPlan(req, res) {
  const { name, description, priceMonthly, priceYearly, maxFloors, maxTables, maxMenuItems, maxStaff, maxBillsPerDay, maxBillsPerMonth, featureWaiterApp, featureDigitalMenu, featureEdineInOrders, featureReservations, featureInventory, featureExpenseManagement, featureEmployeeManagement, featureKds, featureAnalytics } = req.body;
  if (!name || !priceMonthly) return error(res, 'name and priceMonthly are required.', HTTP_STATUS.BAD_REQUEST);

  const [result] = await query(
    `INSERT INTO plans (name, description, price_monthly, price_yearly, max_floors, max_tables, max_menu_items, max_staff, max_bills_per_day, max_bills_per_month, feature_waiter_app, feature_digital_menu, feature_edine_in_orders, feature_reservations, feature_inventory, feature_expense_management, feature_employee_management, feature_kds, feature_analytics)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [name, description || null, priceMonthly, priceYearly || 0, maxFloors || 2, maxTables || 20, maxMenuItems || 100, maxStaff || 10, maxBillsPerDay || 200, maxBillsPerMonth || 5000, featureWaiterApp !== false ? 1 : 0, featureDigitalMenu !== false ? 1 : 0, featureEdineInOrders !== false ? 1 : 0, featureReservations !== false ? 1 : 0, featureInventory !== false ? 1 : 0, featureExpenseManagement !== false ? 1 : 0, featureEmployeeManagement !== false ? 1 : 0, featureKds !== false ? 1 : 0, featureAnalytics !== false ? 1 : 0]
  );
  return success(res, { id: result.insertId }, 'Plan created.', HTTP_STATUS.CREATED);
}

async function updatePlan(req, res) {
  const { id } = req.params;
  const fields = req.body;
  const updates = Object.entries({
    name: fields.name, description: fields.description,
    price_monthly: fields.priceMonthly, price_yearly: fields.priceYearly,
    max_floors: fields.maxFloors, max_tables: fields.maxTables,
    max_menu_items: fields.maxMenuItems, max_staff: fields.maxStaff,
    max_bills_per_day: fields.maxBillsPerDay, max_bills_per_month: fields.maxBillsPerMonth,
    feature_waiter_app: fields.featureWaiterApp !== undefined ? (fields.featureWaiterApp ? 1 : 0) : undefined,
    feature_digital_menu: fields.featureDigitalMenu !== undefined ? (fields.featureDigitalMenu ? 1 : 0) : undefined,
    feature_edine_in_orders: fields.featureEdineInOrders !== undefined ? (fields.featureEdineInOrders ? 1 : 0) : undefined,
    feature_reservations: fields.featureReservations !== undefined ? (fields.featureReservations ? 1 : 0) : undefined,
    feature_inventory: fields.featureInventory !== undefined ? (fields.featureInventory ? 1 : 0) : undefined,
    feature_expense_management: fields.featureExpenseManagement !== undefined ? (fields.featureExpenseManagement ? 1 : 0) : undefined,
    feature_employee_management: fields.featureEmployeeManagement !== undefined ? (fields.featureEmployeeManagement ? 1 : 0) : undefined,
    feature_kds: fields.featureKds !== undefined ? (fields.featureKds ? 1 : 0) : undefined,
    feature_analytics: fields.featureAnalytics !== undefined ? (fields.featureAnalytics ? 1 : 0) : undefined,
    is_active: fields.isActive !== undefined ? (fields.isActive ? 1 : 0) : undefined,
  }).filter(([, v]) => v !== undefined);

  if (!updates.length) return error(res, 'No fields to update.', HTTP_STATUS.BAD_REQUEST);

  const sql = `UPDATE plans SET ${updates.map(([k]) => `${k} = ?`).join(', ')} WHERE id = ?`;
  await query(sql, [...updates.map(([, v]) => v), id]);
  return success(res, null, 'Plan updated.');
}

async function deletePlan(req, res) {
  const { id } = req.params;
  // Check if this is the only default plan
  const [plan] = await query('SELECT is_default FROM plans WHERE id = ? LIMIT 1', [id]);
  if (!plan || plan.length === 0) return error(res, 'Plan not found.', HTTP_STATUS.NOT_FOUND);
  if (plan[0].is_default) return error(res, 'Cannot delete the default plan. Set another plan as default first.', HTTP_STATUS.BAD_REQUEST);
  // Soft delete — existing subscriptions keep working, plan unavailable for new/renew
  await query('UPDATE plans SET is_active = 0 WHERE id = ?', [id]);
  return success(res, null, 'Plan archived. Existing subscriptions continue unaffected.');
}

async function getSettlements(req, res) {
  const { page, limit, startDate, endDate, restaurantId, search } = req.query;
  const parsedPage = parseInt(page) || 1;
  const parsedLimit = parseInt(limit) || 20;
  const offset = (parsedPage - 1) * parsedLimit;
  let where = 'WHERE 1=1';
  const params = [];
  if (startDate) { where += ' AND DATE(sp.created_at) >= ?'; params.push(startDate); }
  if (endDate) { where += ' AND DATE(sp.created_at) <= ?'; params.push(endDate); }
  if (restaurantId) { where += ' AND sp.restaurant_id = ?'; params.push(restaurantId); }
  if (search) { where += ' AND r.name LIKE ?'; params.push(`%${search}%`); }

  const [countRows] = await query(
    `SELECT COUNT(*) AS total FROM subscription_payments sp LEFT JOIN restaurants r ON r.id = sp.restaurant_id ${where}`,
    params
  );
  const [rows] = await query(
    `SELECT sp.*, r.name AS restaurant_name, p.name AS plan_name, u.name AS processed_by_name
     FROM subscription_payments sp
     LEFT JOIN restaurants r ON r.id = sp.restaurant_id
     LEFT JOIN plans p ON p.id = sp.plan_id
     LEFT JOIN users u ON u.id = sp.processed_by
     ${where} ORDER BY sp.created_at DESC LIMIT ? OFFSET ?`,
    [...params, parsedLimit, offset]
  );

  const [totalRow] = await query(`SELECT COALESCE(SUM(sp.amount), 0) AS total_amount FROM subscription_payments sp LEFT JOIN restaurants r ON r.id = sp.restaurant_id ${where}`, params);

  return paginate(res, { settlements: rows, totalAmount: parseFloat(totalRow[0].total_amount) }, countRows[0].total, parsedPage, parsedLimit, 'Settlements retrieved.');
}


async function resetUserPassword(req, res) {
  const { userId } = req.params;
  const { newPassword } = req.body;
  if (!newPassword || newPassword.length < 8) return error(res, 'New password must be at least 8 characters.', HTTP_STATUS.BAD_REQUEST);
  const hash = await bcrypt.hash(newPassword, 12);
  await query('UPDATE users SET password_hash = ? WHERE id = ?', [hash, userId]);
  return success(res, null, 'Password reset successfully.');
}

module.exports = { getDashboard, getAllRestaurants, getRestaurantById, getRestaurantStats, createRestaurant, updateRestaurant, toggleRestaurantStatus, renewSubscription, updateCurrentPlan, overrideFeature, removeOverride, getAllPlans, createPlan, updatePlan, deletePlan, getSettlements, resetUserPassword };
