'use strict';

const bcrypt = require('bcryptjs');
const { query, transaction } = require('../config/database');
const { generateAccessToken, generatePasswordResetToken, verifyPasswordResetToken } = require('../utils/jwt');
const { success, error } = require('../utils/responseHelper');
const { HTTP_STATUS, ROLES } = require('../config/constants');
const { sendPasswordReset, sendWelcome } = require('../utils/email');
const { notifySuperAdmins } = require('./notification.controller');

async function login(req, res) {
  const { email, password } = req.body;
  if (!email || !password) return error(res, 'Email and password are required.', HTTP_STATUS.BAD_REQUEST);

  const [rows] = await query(
    `SELECT u.*, r.name AS restaurant_name, r.type AS restaurant_type, r.subscription_status
     FROM users u
     LEFT JOIN restaurants r ON r.id = u.restaurant_id
     WHERE (u.email = ? OR u.phone = ?) AND u.role != 'deleted'
     LIMIT 1`,
    [email.trim(), email.trim()]
  );

  if (!rows || rows.length === 0) return error(res, 'Invalid credentials.', HTTP_STATUS.UNAUTHORIZED);

  const user = rows[0];
  if (!user.is_active) return error(res, 'Your account has been deactivated.', HTTP_STATUS.FORBIDDEN);

  const passwordMatch = await bcrypt.compare(password, user.password_hash);
  if (!passwordMatch) return error(res, 'Invalid credentials.', HTTP_STATUS.UNAUTHORIZED);

  // Update last login
  await query('UPDATE users SET last_login = NOW() WHERE id = ?', [user.id]);

  const token = generateAccessToken({
    id: user.id, email: user.email, role: user.role,
    restaurantId: user.restaurant_id, name: user.name,
  });

  let sectionAccess = null;
  if (user.section_access) {
    try { sectionAccess = JSON.parse(user.section_access); } catch { sectionAccess = null; }
  }

  return success(res, {
    token,
    user: {
      id: user.id, name: user.name, email: user.email,
      phone: user.phone, role: user.role,
      restaurantId: user.restaurant_id,
      restaurantName: user.restaurant_name,
      restaurantType: user.restaurant_type,
      profileImage: user.profile_image,
      section_access: sectionAccess,
    },
  }, 'Login successful');
}

async function register(req, res) {
  const { restaurantName, restaurantType, ownerName, email, phone, password, address, city, state, planId } = req.body;

  if (!restaurantName || !ownerName || !email || !password) {
    return error(res, 'Restaurant name, owner name, email and password are required.', HTTP_STATUS.BAD_REQUEST);
  }

  // Check if email already used
  const [existing] = await query('SELECT id FROM users WHERE email = ? LIMIT 1', [email.trim()]);
  if (existing && existing.length > 0) return error(res, 'An account with this email already exists.', HTTP_STATUS.CONFLICT);

  const result = await transaction(async (conn) => {
    // Create slug
    const slug = restaurantName.toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-') + '-' + Date.now();

    // Get default plan
    let finalPlanId = planId;
    if (!finalPlanId) {
      const [plans] = await conn.execute('SELECT id FROM plans WHERE is_default = 1 LIMIT 1');
      finalPlanId = plans[0]?.id || 1;
    }

    const [planRows] = await conn.execute('SELECT id FROM plans WHERE id = ? LIMIT 1', [finalPlanId]);
    if (!planRows || planRows.length === 0) finalPlanId = 1;

    // Create restaurant
    const [restResult] = await conn.execute(
      `INSERT INTO restaurants (name, slug, type, email, phone, address, city, state, plan_id, subscription_status, subscription_start, subscription_end)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'trial', NOW(), DATE_ADD(NOW(), INTERVAL 14 DAY))`,
      [restaurantName.trim(), slug, restaurantType || 'dine_in', email.trim(), phone || null, address || null, city || null, state || null, finalPlanId]
    );
    const restaurantId = restResult.insertId;

    // Create owner user
    const passwordHash = await bcrypt.hash(password, 12);
    const [userResult] = await conn.execute(
      'INSERT INTO users (restaurant_id, name, email, phone, password_hash, role, is_active, is_verified) VALUES (?, ?, ?, ?, ?, ?, 1, 1)',
      [restaurantId, ownerName.trim(), email.trim(), phone || null, passwordHash, ROLES.OWNER]
    );

    // Create default bill format settings
    await conn.execute('INSERT INTO bill_format_settings (restaurant_id) VALUES (?)', [restaurantId]);

    return { restaurantId, userId: userResult.insertId };
  });

  // Send welcome email (non-blocking)
  sendWelcome(email, ownerName, restaurantName).catch(() => {});
  // Notify super admins about new registration
  notifySuperAdmins('info', `New Restaurant Registered: ${restaurantName}`, `${restaurantName} (${email}) has self-registered on FineDyn. Plan: Trial (14 days).`, result.restaurantId).catch(() => {});

  return success(res, { restaurantId: result.restaurantId, userId: result.userId }, 'Restaurant registered successfully.', HTTP_STATUS.CREATED);
}

async function forgotPassword(req, res) {
  const { email } = req.body;
  if (!email) return error(res, 'Email is required.', HTTP_STATUS.BAD_REQUEST);

  const [rows] = await query('SELECT id, name, email FROM users WHERE email = ? LIMIT 1', [email.trim()]);
  // Always return success to prevent email enumeration
  if (!rows || rows.length === 0) return success(res, null, 'If this email exists, a reset link has been sent.');

  const user = rows[0];
  const token = generatePasswordResetToken(user.id);
  await query('UPDATE users SET password_reset_token = ?, password_reset_expires = DATE_ADD(NOW(), INTERVAL 1 HOUR) WHERE id = ?', [token, user.id]);

  const resetLink = `${process.env.FRONTEND_URL || 'http://localhost:3000'}/reset-password/${token}`;
  sendPasswordReset(user.email, resetLink).catch(() => {});

  return success(res, null, 'If this email exists, a reset link has been sent.');
}

async function resetPassword(req, res) {
  const { token, password } = req.body;
  if (!token || !password) return error(res, 'Token and password are required.', HTTP_STATUS.BAD_REQUEST);
  if (password.length < 8) return error(res, 'Password must be at least 8 characters.', HTTP_STATUS.BAD_REQUEST);

  let decoded;
  try { decoded = verifyPasswordResetToken(token); }
  catch { return error(res, 'Invalid or expired reset link.', HTTP_STATUS.BAD_REQUEST); }

  const [rows] = await query(
    'SELECT id FROM users WHERE id = ? AND password_reset_token = ? AND password_reset_expires > NOW() LIMIT 1',
    [decoded.id, token]
  );
  if (!rows || rows.length === 0) return error(res, 'Invalid or expired reset link.', HTTP_STATUS.BAD_REQUEST);

  const hash = await bcrypt.hash(password, 12);
  await query('UPDATE users SET password_hash = ?, password_reset_token = NULL, password_reset_expires = NULL WHERE id = ?', [hash, decoded.id]);

  return success(res, null, 'Password reset successfully. Please log in with your new password.');
}

async function getProfile(req, res) {
  const [rows] = await query(
    `SELECT u.id, u.name, u.email, u.phone, u.role, u.restaurant_id, u.profile_image, u.last_login, u.created_at,
            u.section_access, r.name AS restaurant_name, r.type AS restaurant_type
     FROM users u
     LEFT JOIN restaurants r ON r.id = u.restaurant_id
     WHERE u.id = ? LIMIT 1`,
    [req.user.id]
  );
  if (!rows || rows.length === 0) return error(res, 'User not found.', HTTP_STATUS.NOT_FOUND);
  const profile = rows[0];
  if (profile.section_access) {
    try { profile.section_access = JSON.parse(profile.section_access); } catch { profile.section_access = null; }
  }
  return success(res, profile, 'Profile retrieved.');
}

async function updateProfile(req, res) {
  const { name, phone, profileImage } = req.body;
  await query(
    'UPDATE users SET name = COALESCE(?, name), phone = COALESCE(?, phone), profile_image = COALESCE(?, profile_image) WHERE id = ?',
    [name || null, phone || null, profileImage || null, req.user.id]
  );
  return success(res, null, 'Profile updated successfully.');
}

async function changePassword(req, res) {
  const { currentPassword, newPassword } = req.body;
  if (!currentPassword || !newPassword) return error(res, 'Current and new password are required.', HTTP_STATUS.BAD_REQUEST);
  if (newPassword.length < 8) return error(res, 'New password must be at least 8 characters.', HTTP_STATUS.BAD_REQUEST);

  const [rows] = await query('SELECT password_hash FROM users WHERE id = ? LIMIT 1', [req.user.id]);
  if (!rows || rows.length === 0) return error(res, 'User not found.', HTTP_STATUS.NOT_FOUND);

  const match = await bcrypt.compare(currentPassword, rows[0].password_hash);
  if (!match) return error(res, 'Current password is incorrect.', HTTP_STATUS.BAD_REQUEST);

  const hash = await bcrypt.hash(newPassword, 12);
  await query('UPDATE users SET password_hash = ? WHERE id = ?', [hash, req.user.id]);
  return success(res, null, 'Password changed successfully.');
}

async function pinLogin(req, res) {
  const { email, pin } = req.body;
  if (!email || !pin) return error(res, 'Email and PIN are required.', HTTP_STATUS.BAD_REQUEST);

  const [rows] = await query(
    `SELECT u.*, r.name AS restaurant_name, r.type AS restaurant_type, r.subscription_status
     FROM users u
     LEFT JOIN restaurants r ON r.id = u.restaurant_id
     WHERE u.email = ? AND u.role != 'deleted'
     LIMIT 1`,
    [email.trim()]
  );

  if (!rows || rows.length === 0) return error(res, 'Invalid credentials.', HTTP_STATUS.UNAUTHORIZED);

  const user = rows[0];
  if (!user.is_active) return error(res, 'Your account has been deactivated.', HTTP_STATUS.FORBIDDEN);
  if (!user.pin_code) return error(res, 'PIN login not configured for this account. Please ask your administrator to set a PIN.', HTTP_STATUS.UNAUTHORIZED);
  if (user.pin_code !== String(pin)) return error(res, 'Invalid PIN.', HTTP_STATUS.UNAUTHORIZED);

  await query('UPDATE users SET last_login = NOW() WHERE id = ?', [user.id]);

  const token = generateAccessToken({
    id: user.id, email: user.email, role: user.role,
    restaurantId: user.restaurant_id, name: user.name,
  });

  let pinSectionAccess = null;
  if (user.section_access) {
    try { pinSectionAccess = JSON.parse(user.section_access); } catch { pinSectionAccess = null; }
  }

  return success(res, {
    token,
    user: {
      id: user.id, name: user.name, email: user.email,
      phone: user.phone, role: user.role,
      restaurantId: user.restaurant_id,
      restaurantName: user.restaurant_name,
      restaurantType: user.restaurant_type,
      profileImage: user.profile_image,
      section_access: pinSectionAccess,
    },
  }, 'Login successful');
}

async function logout(req, res) {
  return success(res, null, 'Logged out successfully.');
}

module.exports = { login, register, forgotPassword, resetPassword, getProfile, updateProfile, changePassword, logout, pinLogin };
