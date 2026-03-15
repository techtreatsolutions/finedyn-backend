'use strict';

const bcrypt = require('bcryptjs');
const { query } = require('../config/database');
const { success, error } = require('../utils/responseHelper');
const { HTTP_STATUS, ROLES } = require('../config/constants');
const { getEffectiveFeatures } = require('../utils/featureEngine');

async function getRestaurantProfile(req, res) {
  const [rows] = await query(
    'SELECT r.*, p.name AS plan_name, p.price_monthly FROM restaurants r LEFT JOIN plans p ON p.id = r.plan_id WHERE r.id = ? LIMIT 1',
    [req.user.restaurantId]
  );
  if (!rows || rows.length === 0) return error(res, 'Restaurant not found.', HTTP_STATUS.NOT_FOUND);
  return success(res, rows[0]);
}

async function updateRestaurantProfile(req, res) {
  const { name, phone, address, city, state, pincode, gstin, fssaiNumber, timezone, billPrefix, logoUrl } = req.body;
  await query(
    `UPDATE restaurants SET
      name = COALESCE(?, name), phone = COALESCE(?, phone), address = COALESCE(?, address),
      city = COALESCE(?, city), state = COALESCE(?, state), pincode = COALESCE(?, pincode),
      gstin = COALESCE(?, gstin), fssai_number = COALESCE(?, fssai_number),
      timezone = COALESCE(?, timezone), bill_prefix = COALESCE(?, bill_prefix),
      logo_url = COALESCE(?, logo_url)
     WHERE id = ?`,
    [name || null, phone || null, address || null, city || null, state || null, pincode || null, gstin || null, fssaiNumber || null, timezone || null, billPrefix || null, logoUrl || null, req.user.restaurantId]
  );
  return success(res, null, 'Profile updated.');
}

async function getSubscriptionInfo(req, res) {
  const rId = req.user.restaurantId;
  const [rows] = await query(
    'SELECT r.subscription_status, r.subscription_start, r.subscription_end, p.* FROM restaurants r LEFT JOIN plans p ON p.id = r.plan_id WHERE r.id = ? LIMIT 1',
    [rId]
  );
  if (!rows || rows.length === 0) return error(res, 'Not found.', HTTP_STATUS.NOT_FOUND);

  const features = await getEffectiveFeatures(rId);

  // Usage counts
  const [[tableCount], [itemCount], [staffCount], [floorCount], [billsTodayCount], [billsMonthCount]] = await Promise.all([
    query('SELECT COUNT(*) AS count FROM tables WHERE restaurant_id = ? AND is_active = 1', [rId]),
    query('SELECT COUNT(*) AS count FROM menu_items WHERE restaurant_id = ? AND is_available = 1', [rId]),
    query('SELECT COUNT(*) AS count FROM users WHERE restaurant_id = ? AND is_active = 1', [rId]),
    query('SELECT COUNT(*) AS count FROM floors WHERE restaurant_id = ? AND is_active = 1', [rId]),
    query('SELECT COUNT(*) AS count FROM orders WHERE restaurant_id = ? AND DATE(created_at) = CURDATE()', [rId]),
    query('SELECT COUNT(*) AS count FROM orders WHERE restaurant_id = ? AND MONTH(created_at) = MONTH(CURDATE()) AND YEAR(created_at) = YEAR(CURDATE())', [rId]),
  ]);

  return success(res, {
    subscription: rows[0],
    features,
    usage: {
      tables: tableCount[0].count,
      menuItems: itemCount[0].count,
      staff: staffCount[0].count,
      floors: floorCount[0].count,
      billsToday: billsTodayCount[0].count,
      billsMonth: billsMonthCount[0].count,
    },
  });
}

async function getDashboardStats(req, res) {
  const rId = req.user.restaurantId;

  const [[todayStats], [last7Days], [popularItems], [recentOrders]] = await Promise.all([
    query(`SELECT
      COUNT(*) AS total_orders, COALESCE(SUM(total_amount), 0) AS total_revenue,
      COUNT(CASE WHEN payment_status = 'unpaid' AND status NOT IN ('cancelled','completed') THEN 1 END) AS pending_orders,
      COUNT(CASE WHEN status = 'preparing' THEN 1 END) AS preparing_orders
      FROM orders WHERE restaurant_id = ? AND DATE(created_at) = CURDATE()`, [rId]),

    query(`SELECT DATE(created_at) AS date, COUNT(*) AS orders, COALESCE(SUM(total_amount), 0) AS revenue
      FROM orders WHERE restaurant_id = ? AND created_at >= DATE_SUB(NOW(), INTERVAL 7 DAY) AND payment_status = 'paid'
      GROUP BY DATE(created_at) ORDER BY date ASC`, [rId]),

    query(`SELECT oi.item_name, SUM(oi.quantity) AS total_qty, SUM(oi.total_price) AS total_revenue
      FROM order_items oi JOIN orders o ON o.id = oi.order_id
      WHERE oi.restaurant_id = ? AND DATE(o.created_at) = CURDATE()
      GROUP BY oi.item_name ORDER BY total_qty DESC LIMIT 5`, [rId]),

    query(`SELECT o.id, o.order_number, o.status, o.total_amount, o.payment_status, o.order_type,
            t.table_number, o.created_at
            FROM orders o LEFT JOIN tables t ON t.id = o.table_id
            WHERE o.restaurant_id = ? ORDER BY o.created_at DESC LIMIT 10`, [rId]),
  ]);

  // Active tables count
  const [[activeTables]] = await query('SELECT COUNT(*) AS count FROM tables WHERE restaurant_id = ? AND status = \'occupied\'', [rId]);

  return success(res, {
    today: { ...todayStats[0], activeTables: activeTables.count },
    salesLast7Days: last7Days,
    popularItems,
    recentOrders,
  });
}

async function getUsers(req, res) {
  const [rows] = await query(
    'SELECT id, name, email, phone, role, is_active, last_login, created_at, section_access, (pin_code IS NOT NULL) AS has_pin FROM users WHERE restaurant_id = ? ORDER BY role, name',
    [req.user.restaurantId]
  );
  const parsed = rows.map(r => {
    if (r.section_access) {
      try { r.section_access = JSON.parse(r.section_access); } catch { r.section_access = null; }
    }
    return r;
  });
  return success(res, parsed);
}

async function createUser(req, res) {
  const { name, email, phone, role, password, pinCode } = req.body;
  if (!name || !email || !role) return error(res, 'name, email and role are required.', HTTP_STATUS.BAD_REQUEST);

  const allowedRoles = [ROLES.MANAGER, ROLES.CASHIER, ROLES.WAITER, ROLES.KITCHEN_STAFF];
  if (!allowedRoles.includes(role)) return error(res, 'Invalid role. Allowed: manager, cashier, waiter, kitchen_staff.', HTTP_STATUS.BAD_REQUEST);

  const [existing] = await query('SELECT id FROM users WHERE email = ? LIMIT 1', [email.trim()]);
  if (existing && existing.length > 0) return error(res, 'Email already in use.', HTTP_STATUS.CONFLICT);

  const finalPassword = password || 'FineDyn@123';
  const hash = await bcrypt.hash(finalPassword, 12);
  const pin = pinCode ? String(pinCode).trim() : null;
  const [result] = await query(
    'INSERT INTO users (restaurant_id, name, email, phone, password_hash, role, pin_code, is_active, is_verified) VALUES (?, ?, ?, ?, ?, ?, ?, 1, 1)',
    [req.user.restaurantId, name.trim(), email.trim(), phone || null, hash, role, pin]
  );
  return success(res, { id: result.insertId, tempPassword: finalPassword }, 'Staff created.', HTTP_STATUS.CREATED);
}

async function updateUser(req, res) {
  const { userId } = req.params;
  const { name, email, phone, role, isActive, pinCode, sectionAccess } = req.body;

  const sets = [];
  const vals = [];
  if (name !== undefined) { sets.push('name = ?'); vals.push(name.trim()); }
  if (email !== undefined) { sets.push('email = ?'); vals.push(email.trim()); }
  if (phone !== undefined) { sets.push('phone = ?'); vals.push(phone || null); }
  if (role !== undefined) {
    const allowedRoles = [ROLES.MANAGER, ROLES.CASHIER, ROLES.WAITER, ROLES.KITCHEN_STAFF];
    if (!allowedRoles.includes(role)) return error(res, 'Invalid role.', HTTP_STATUS.BAD_REQUEST);
    sets.push('role = ?'); vals.push(role);
  }
  if (isActive !== undefined) { sets.push('is_active = ?'); vals.push(isActive ? 1 : 0); }
  if (pinCode !== undefined) { sets.push('pin_code = ?'); vals.push(pinCode ? String(pinCode).trim() : null); }
  if (sectionAccess !== undefined) { sets.push('section_access = ?'); vals.push(sectionAccess ? JSON.stringify(sectionAccess) : null); }

  if (sets.length === 0) return success(res, null, 'Nothing to update.');

  vals.push(userId, req.user.restaurantId);
  await query(`UPDATE users SET ${sets.join(', ')} WHERE id = ? AND restaurant_id = ?`, vals);
  return success(res, null, 'User updated.');
}

async function deleteUser(req, res) {
  const { userId } = req.params;
  const [rows] = await query('SELECT id, role FROM users WHERE id = ? AND restaurant_id = ? LIMIT 1', [userId, req.user.restaurantId]);
  if (!rows || rows.length === 0) return error(res, 'User not found.', HTTP_STATUS.NOT_FOUND);
  if (rows[0].role === 'owner') return error(res, 'Cannot delete the owner account.', HTTP_STATUS.FORBIDDEN);
  await query('DELETE FROM users WHERE id = ? AND restaurant_id = ?', [userId, req.user.restaurantId]);
  return success(res, null, 'User deleted.');
}

async function resetStaffPassword(req, res) {
  const { userId } = req.params;
  const { newPassword } = req.body;
  if (!newPassword || newPassword.length < 8) return error(res, 'Password must be at least 8 chars.', HTTP_STATUS.BAD_REQUEST);

  const [rows] = await query('SELECT id FROM users WHERE id = ? AND restaurant_id = ? AND role != \'owner\'', [userId, req.user.restaurantId]);
  if (!rows || rows.length === 0) return error(res, 'User not found.', HTTP_STATUS.NOT_FOUND);

  const hash = await bcrypt.hash(newPassword, 12);
  await query('UPDATE users SET password_hash = ? WHERE id = ?', [hash, userId]);
  return success(res, null, 'Password reset.');
}

async function getBillFormatSettings(req, res) {
  const [rows] = await query('SELECT * FROM bill_format_settings WHERE restaurant_id = ? LIMIT 1', [req.user.restaurantId]);
  if (!rows || rows.length === 0) {
    await query('INSERT INTO bill_format_settings (restaurant_id) VALUES (?)', [req.user.restaurantId]);
    const [newRows] = await query('SELECT * FROM bill_format_settings WHERE restaurant_id = ? LIMIT 1', [req.user.restaurantId]);
    return success(res, newRows[0]);
  }
  return success(res, rows[0]);
}

async function updateBillFormatSettings(req, res) {
  const { showRestaurantName, showLogo, showAddress, showContact, showGst, showWaiterName, showTableNumber, showDateTime, showPaymentMode, showCustomerDetails, enableTax, customHeader, customFooter, headerImageUrl, footerImageUrl, thankYouMessage, billPrinterSizeMm, kotPrinterSizeMm } = req.body;

  const billSize = parseInt(billPrinterSizeMm, 10) || 80;
  const kotSize = parseInt(kotPrinterSizeMm, 10) || 80;

  await query(`INSERT INTO bill_format_settings (restaurant_id, show_restaurant_name, show_logo, show_address, show_contact, show_gst, show_waiter_name, show_table_number, show_date_time, show_payment_mode, show_customer_details, enable_tax, custom_header, custom_footer, header_image_url, footer_image_url, thank_you_message, bill_printer_size_mm, kot_printer_size_mm)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE show_restaurant_name = ?, show_logo = ?, show_address = ?, show_contact = ?, show_gst = ?, show_waiter_name = ?, show_table_number = ?, show_date_time = ?, show_payment_mode = ?, show_customer_details = ?, enable_tax = ?, custom_header = ?, custom_footer = ?, header_image_url = ?, footer_image_url = ?, thank_you_message = ?, bill_printer_size_mm = ?, kot_printer_size_mm = ?`,
    [req.user.restaurantId, showRestaurantName ? 1 : 0, showLogo ? 1 : 0, showAddress ? 1 : 0, showContact ? 1 : 0, showGst ? 1 : 0, showWaiterName ? 1 : 0, showTableNumber ? 1 : 0, showDateTime ? 1 : 0, showPaymentMode ? 1 : 0, showCustomerDetails ? 1 : 0, enableTax ? 1 : 0, customHeader || null, customFooter || null, headerImageUrl || null, footerImageUrl || null, thankYouMessage || null, billSize, kotSize,
    showRestaurantName ? 1 : 0, showLogo ? 1 : 0, showAddress ? 1 : 0, showContact ? 1 : 0, showGst ? 1 : 0, showWaiterName ? 1 : 0, showTableNumber ? 1 : 0, showDateTime ? 1 : 0, showPaymentMode ? 1 : 0, showCustomerDetails ? 1 : 0, enableTax ? 1 : 0, customHeader || null, customFooter || null, headerImageUrl || null, footerImageUrl || null, thankYouMessage || null, billSize, kotSize]
  );
  return success(res, null, 'Bill format settings updated.');
}

module.exports = { getRestaurantProfile, updateRestaurantProfile, getSubscriptionInfo, getDashboardStats, getUsers, createUser, updateUser, deleteUser, resetStaffPassword, getBillFormatSettings, updateBillFormatSettings };
