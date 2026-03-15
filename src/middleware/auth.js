'use strict';

const { verifyToken } = require('../utils/jwt');
const { query } = require('../config/database');
const { error } = require('../utils/responseHelper');
const { HTTP_STATUS } = require('../config/constants');

async function authenticate(req, res, next) {
  try {
    const authHeader = req.headers['authorization'];
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return error(res, 'Access denied. No token provided.', HTTP_STATUS.UNAUTHORIZED);
    }
    const token = authHeader.split(' ')[1];
    if (!token) return error(res, 'Access denied. Malformed authorization header.', HTTP_STATUS.UNAUTHORIZED);

    let decoded;
    try {
      decoded = verifyToken(token);
    } catch (err) {
      if (err.name === 'TokenExpiredError') return error(res, 'Token has expired. Please log in again.', HTTP_STATUS.UNAUTHORIZED);
      if (err.name === 'JsonWebTokenError') return error(res, 'Invalid token. Please log in again.', HTTP_STATUS.UNAUTHORIZED);
      return error(res, 'Token verification failed.', HTTP_STATUS.UNAUTHORIZED);
    }

    const [rows] = await query(
      `SELECT u.id, u.email, u.role, u.restaurant_id, u.name, u.is_active, u.active_session_id,
              r.is_active AS restaurant_active, r.subscription_status
       FROM users u
       LEFT JOIN restaurants r ON r.id = u.restaurant_id
       WHERE u.id = ? LIMIT 1`,
      [decoded.id]
    );

    if (!rows || rows.length === 0) return error(res, 'User not found.', HTTP_STATUS.UNAUTHORIZED);

    const user = rows[0];
    if (!user.is_active) return error(res, 'Your account has been deactivated.', HTTP_STATUS.FORBIDDEN);
    if (user.role !== 'super_admin' && user.restaurant_id && user.restaurant_active === 0) {
      return error(res, 'Your restaurant account is inactive.', HTTP_STATUS.FORBIDDEN);
    }

    // Single-session enforcement: reject if session ID doesn't match (logged in elsewhere)
    if (decoded.sid && user.active_session_id && decoded.sid !== user.active_session_id) {
      return error(res, 'Your session has expired because your account was logged in on another device.', HTTP_STATUS.UNAUTHORIZED);
    }

    req.user = {
      id: user.id,
      email: user.email,
      role: user.role,
      restaurantId: user.restaurant_id || null,
      name: user.name,
    };
    return next();
  } catch (err) {
    console.error('[Auth] Error:', err.message);
    return error(res, 'Authentication error.', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
}

// Like authenticate but does NOT reject when no token is present.
// Populates req.user if a valid token exists; otherwise continues silently.
async function optionalAuth(req, res, next) {
  try {
    const authHeader = req.headers['authorization'];
    if (!authHeader || !authHeader.startsWith('Bearer ')) return next();

    const token = authHeader.split(' ')[1];
    if (!token) return next();

    let decoded;
    try {
      decoded = verifyToken(token);
    } catch {
      return next(); // invalid/expired token — just skip
    }

    const [rows] = await query(
      `SELECT u.id, u.email, u.role, u.restaurant_id, u.name, u.is_active
       FROM users u WHERE u.id = ? LIMIT 1`,
      [decoded.id]
    );

    if (rows && rows.length > 0 && rows[0].is_active) {
      req.user = {
        id: rows[0].id,
        email: rows[0].email,
        role: rows[0].role,
        restaurantId: rows[0].restaurant_id || null,
        name: rows[0].name,
      };
    }
  } catch {
    // Silently ignore — this is optional auth
  }
  return next();
}

module.exports = { authenticate, optionalAuth };
