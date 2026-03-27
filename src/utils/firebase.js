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
  if (!firebaseInitialized) {
    console.warn('[Firebase] Push skipped — SDK not initialized.');
    return null;
  }
  if (!fcmToken) {
    console.warn('[Firebase] Push skipped — no FCM token provided.');
    return null;
  }

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
    console.log(`[Firebase] Push sent: "${title}" → token:${fcmToken.substring(0, 12)}...`);
    return response;
  } catch (err) {
    // If token is invalid/expired, deactivate it
    if (
      err.code === 'messaging/invalid-registration-token' ||
      err.code === 'messaging/registration-token-not-registered'
    ) {
      console.warn(`[Firebase] Deactivating invalid token: ${fcmToken.substring(0, 12)}...`);
      await query('UPDATE device_tokens SET is_active = 0 WHERE fcm_token = ?', [fcmToken]);
    } else {
      console.error(`[Firebase] Push failed for "${title}":`, err.code || err.message);
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
    if (!tokens || tokens.length === 0) {
      console.log(`[Firebase] No active tokens for user ${userId}`);
      return;
    }

    console.log(`[Firebase] Sending "${title}" to user ${userId} (${tokens.length} device(s))`);
    const promises = tokens.map(t => sendPush(t.fcm_token, title, body, data));
    await Promise.allSettled(promises);
  } catch (err) { console.error('[Firebase] sendPushToUser error:', err.message); }
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
       WHERE (dt.restaurant_id = ? OR (dt.restaurant_id IS NULL AND u.restaurant_id = ?))
         AND u.role = ? AND dt.is_active = 1 AND u.is_active = 1`,
      [restaurantId, restaurantId, role]
    );
    if (!tokens || tokens.length === 0) {
      console.log(`[Firebase] No active tokens for role "${role}" in restaurant ${restaurantId}`);
      return;
    }

    console.log(`[Firebase] Sending "${title}" to ${tokens.length} ${role}(s) in restaurant ${restaurantId}`);
    const promises = tokens.map(t => sendPush(t.fcm_token, title, body, data));
    await Promise.allSettled(promises);
  } catch (err) { console.error('[Firebase] sendPushToRole error:', err.message); }
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
       WHERE (dt.restaurant_id = ? OR (dt.restaurant_id IS NULL AND u.restaurant_id = ?))
         AND u.role IN ('owner', 'manager') AND dt.is_active = 1 AND u.is_active = 1`,
      [restaurantId, restaurantId]
    );
    if (!tokens || tokens.length === 0) {
      console.log(`[Firebase] No active tokens for admins in restaurant ${restaurantId}`);
      return;
    }

    console.log(`[Firebase] Sending "${title}" to ${tokens.length} admin(s) in restaurant ${restaurantId}`);
    const promises = tokens.map(t => sendPush(t.fcm_token, title, body, data));
    await Promise.allSettled(promises);
  } catch (err) { console.error('[Firebase] sendPushToAdmins error:', err.message); }
}

/**
 * Send push notification to all active devices of a restaurant (all roles).
 */
async function sendPushToRestaurant(restaurantId, title, body, data = {}) {
  if (!firebaseInitialized) return;

  try {
    const [tokens] = await query(
      `SELECT dt.fcm_token FROM device_tokens dt
       LEFT JOIN users u ON u.id = dt.user_id
       WHERE (dt.restaurant_id = ? OR (dt.restaurant_id IS NULL AND u.restaurant_id = ?))
         AND dt.is_active = 1`,
      [restaurantId, restaurantId]
    );
    if (!tokens || tokens.length === 0) return;

    console.log(`[Firebase] Sending "${title}" to ${tokens.length} device(s) in restaurant ${restaurantId}`);
    const promises = tokens.map(t => sendPush(t.fcm_token, title, body, data));
    await Promise.allSettled(promises);
  } catch (err) { console.error('[Firebase] sendPushToRestaurant error:', err.message); }
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
