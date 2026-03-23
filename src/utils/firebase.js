'use strict';

const admin = require('firebase-admin');
const path = require('path');
const fs = require('fs');
const { query } = require('../config/database');

// Initialize Firebase Admin SDK
let firebaseInitialized = false;

function initFirebase() {
  if (firebaseInitialized) return;

  try {
    const serviceAccountPath = path.join(__dirname, '..', '..', 'firebase-service-account.json');
    if (fs.existsSync(serviceAccountPath)) {
      const serviceAccount = require(serviceAccountPath);
      admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
      });
      firebaseInitialized = true;
      console.log('[Firebase] Admin SDK initialized successfully.');
    } else {
      console.warn('[Firebase] Service account file not found at:', serviceAccountPath);
      console.warn('[Firebase] Push notifications will be disabled. Place firebase-service-account.json in backend/ root.');
    }
  } catch (err) {
    console.error('[Firebase] Failed to initialize:', err.message);
  }
}

// Initialize on module load
initFirebase();

/**
 * Send push notification to a single FCM token.
 */
async function sendPush(fcmToken, title, body, data = {}) {
  if (!firebaseInitialized) return null;

  try {
    const message = {
      token: fcmToken,
      notification: { title, body },
      data: Object.fromEntries(
        Object.entries(data).map(([k, v]) => [k, String(v)])
      ),
      android: {
        priority: 'high',
        notification: {
          channelId: 'finedyn_order_alerts_v2',
          sound: 'order_alert',
          icon: 'ic_notification',
          defaultVibrateTimings: false,
          vibrateTimingsMillis: [0, 400, 200, 400, 200, 400],
          notificationCount: 1,
        },
      },
      apns: {
        payload: {
          aps: {
            sound: { critical: 1, name: 'default', volume: 1.0 },
            'interruption-level': 'time-sensitive',
          },
        },
      },
    };
    const response = await admin.messaging().send(message);
    return response;
  } catch (err) {
    // If token is invalid/expired, deactivate it
    if (
      err.code === 'messaging/invalid-registration-token' ||
      err.code === 'messaging/registration-token-not-registered'
    ) {
      await query('UPDATE device_tokens SET is_active = 0 WHERE fcm_token = ?', [fcmToken]);
    }
    return null;
  }
}

/**
 * Send push notification to all active devices of a specific user.
 */
async function sendPushToUser(userId, title, body, data = {}) {
  if (!firebaseInitialized) return;

  try {
    const [tokens] = await query(
      'SELECT fcm_token FROM device_tokens WHERE user_id = ? AND is_active = 1',
      [userId]
    );
    if (!tokens || tokens.length === 0) return;

    const promises = tokens.map(t => sendPush(t.fcm_token, title, body, data));
    await Promise.allSettled(promises);
  } catch (_) { /* non-critical */ }
}

/**
 * Send push notification to all active devices of users with a specific role in a restaurant.
 */
async function sendPushToRole(restaurantId, role, title, body, data = {}) {
  if (!firebaseInitialized) return;

  try {
    const [tokens] = await query(
      `SELECT dt.fcm_token FROM device_tokens dt
       JOIN users u ON u.id = dt.user_id
       WHERE dt.restaurant_id = ? AND u.role = ? AND dt.is_active = 1 AND u.is_active = 1`,
      [restaurantId, role]
    );
    if (!tokens || tokens.length === 0) return;

    const promises = tokens.map(t => sendPush(t.fcm_token, title, body, data));
    await Promise.allSettled(promises);
  } catch (_) { /* non-critical */ }
}

/**
 * Send push notification to all admins (owner + manager) of a restaurant.
 */
async function sendPushToAdmins(restaurantId, title, body, data = {}) {
  if (!firebaseInitialized) return;

  try {
    const [tokens] = await query(
      `SELECT dt.fcm_token FROM device_tokens dt
       JOIN users u ON u.id = dt.user_id
       WHERE dt.restaurant_id = ? AND u.role IN ('owner', 'manager') AND dt.is_active = 1 AND u.is_active = 1`,
      [restaurantId]
    );
    if (!tokens || tokens.length === 0) return;

    const promises = tokens.map(t => sendPush(t.fcm_token, title, body, data));
    await Promise.allSettled(promises);
  } catch (_) { /* non-critical */ }
}

/**
 * Send push notification to all active devices of a restaurant (all roles).
 */
async function sendPushToRestaurant(restaurantId, title, body, data = {}) {
  if (!firebaseInitialized) return;

  try {
    const [tokens] = await query(
      `SELECT dt.fcm_token FROM device_tokens dt
       WHERE dt.restaurant_id = ? AND dt.is_active = 1`,
      [restaurantId]
    );
    if (!tokens || tokens.length === 0) return;

    const promises = tokens.map(t => sendPush(t.fcm_token, title, body, data));
    await Promise.allSettled(promises);
  } catch (_) { /* non-critical */ }
}

/**
 * Register a device token for a user.
 */
async function registerDeviceToken(userId, restaurantId, fcmToken, platform = 'android') {
  try {
    await query(
      `INSERT INTO device_tokens (user_id, restaurant_id, fcm_token, platform, is_active)
       VALUES (?, ?, ?, ?, 1)
       ON DUPLICATE KEY UPDATE user_id = ?, restaurant_id = ?, platform = ?, is_active = 1, updated_at = NOW()`,
      [userId, restaurantId || null, fcmToken, platform, userId, restaurantId || null, platform]
    );
    return true;
  } catch (err) {
    console.error('[Firebase] Failed to register device token:', err.message);
    return false;
  }
}

/**
 * Unregister (deactivate) a device token.
 */
async function unregisterDeviceToken(fcmToken) {
  try {
    await query('UPDATE device_tokens SET is_active = 0 WHERE fcm_token = ?', [fcmToken]);
    return true;
  } catch (_) { return false; }
}

module.exports = {
  sendPush,
  sendPushToUser,
  sendPushToRole,
  sendPushToAdmins,
  sendPushToRestaurant,
  registerDeviceToken,
  unregisterDeviceToken,
};
