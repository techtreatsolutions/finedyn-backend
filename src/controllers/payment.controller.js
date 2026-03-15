'use strict';

const { query, transaction } = require('../config/database');
const { success, error } = require('../utils/responseHelper');
const { HTTP_STATUS } = require('../config/constants');
const { encrypt, decrypt } = require('../utils/encryption');

/* ─── gateway settings ─────────────────────────────────────────────────────── */

async function getGatewaySettings(req, res) {
  // Schema column: `gateway` (not gateway_name); keys stored encrypted separately
  const [rows] = await query(
    'SELECT id, gateway, is_active, is_test_mode, updated_at FROM payment_gateway_settings WHERE restaurant_id = ?',
    [req.user.restaurantId]
  );
  // Return with frontend-compatible field name
  const mapped = rows.map(r => ({ ...r, gateway_name: r.gateway }));
  return success(res, mapped);
}

async function saveGatewaySettings(req, res) {
  const { gatewayName, apiKey, apiSecret, webhookSecret, isActive, isTestMode } = req.body;
  if (!gatewayName || !apiKey) return error(res, 'gatewayName and apiKey are required.', HTTP_STATUS.BAD_REQUEST);

  const encApiKey = encrypt(apiKey);
  const encApiSecret = apiSecret ? encrypt(apiSecret) : null;
  const encWebhook = webhookSecret ? encrypt(webhookSecret) : null;

  // Schema uses `gateway` column (ENUM), and `api_key_encrypted`, `api_secret_encrypted`, `webhook_secret_encrypted`
  const [existing] = await query(
    'SELECT id FROM payment_gateway_settings WHERE restaurant_id = ? AND gateway = ? LIMIT 1',
    [req.user.restaurantId, gatewayName]
  );

  if (existing && existing.length > 0) {
    await query(
      `UPDATE payment_gateway_settings
       SET api_key_encrypted = ?, api_secret_encrypted = ?, webhook_secret_encrypted = ?, is_active = ?, is_test_mode = ?
       WHERE id = ?`,
      [encApiKey, encApiSecret, encWebhook, isActive ? 1 : 0, isTestMode ? 1 : 0, existing[0].id]
    );
  } else {
    await query(
      `INSERT INTO payment_gateway_settings (restaurant_id, gateway, api_key_encrypted, api_secret_encrypted, webhook_secret_encrypted, is_active, is_test_mode)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [req.user.restaurantId, gatewayName, encApiKey, encApiSecret, encWebhook, isActive ? 1 : 0, isTestMode ? 1 : 0]
    );
  }

  return success(res, null, 'Gateway settings saved.');
}

/* ─── Razorpay order creation ──────────────────────────────────────────────── */

async function createRazorpayOrder(req, res) {
  const { orderId } = req.body;

  const [orderRows] = await query(
    'SELECT * FROM orders WHERE id = ? AND restaurant_id = ? LIMIT 1',
    [orderId, req.user.restaurantId]
  );
  if (!orderRows || orderRows.length === 0) return error(res, 'Order not found.', HTTP_STATUS.NOT_FOUND);
  const order = orderRows[0];

  const [gwRows] = await query(
    "SELECT * FROM payment_gateway_settings WHERE restaurant_id = ? AND gateway = 'razorpay' AND is_active = 1 LIMIT 1",
    [req.user.restaurantId]
  );
  if (!gwRows || gwRows.length === 0) return error(res, 'Razorpay not configured.', HTTP_STATUS.BAD_REQUEST);

  const gw = gwRows[0];
  let Razorpay;
  try { Razorpay = require('razorpay'); } catch (e) {
    return error(res, 'Razorpay package not installed.', HTTP_STATUS.SERVER_ERROR);
  }

  const razorpay = new Razorpay({
    key_id: decrypt(gw.api_key_encrypted),
    key_secret: decrypt(gw.api_secret_encrypted),
  });

  const rpOrder = await razorpay.orders.create({
    amount: Math.round(order.total_amount * 100),
    currency: 'INR',
    receipt: order.order_number,
    notes: { orderId: String(orderId), restaurantId: String(req.user.restaurantId) },
  });

  // Store pending payment record
  await query(
    `INSERT INTO payments (order_id, restaurant_id, amount, payment_mode, gateway, gateway_order_id, status)
     VALUES (?, ?, ?, 'online', 'razorpay', ?, 'pending')`,
    [orderId, req.user.restaurantId, order.total_amount, rpOrder.id]
  );

  return success(res, {
    razorpayOrderId: rpOrder.id,
    amount: rpOrder.amount,
    currency: rpOrder.currency,
    keyId: decrypt(gw.api_key_encrypted),
  });
}

async function verifyRazorpayPayment(req, res) {
  const { razorpayOrderId, razorpayPaymentId, razorpaySignature, orderId } = req.body;

  const [gwRows] = await query(
    "SELECT * FROM payment_gateway_settings WHERE restaurant_id = ? AND gateway = 'razorpay' AND is_active = 1 LIMIT 1",
    [req.user.restaurantId]
  );
  if (!gwRows || gwRows.length === 0) return error(res, 'Razorpay not configured.', HTTP_STATUS.BAD_REQUEST);

  const crypto = require('crypto');
  const body = razorpayOrderId + '|' + razorpayPaymentId;
  const expectedSig = crypto.createHmac('sha256', decrypt(gwRows[0].api_secret_encrypted)).update(body).digest('hex');
  if (expectedSig !== razorpaySignature) return error(res, 'Payment verification failed.', HTTP_STATUS.BAD_REQUEST);

  const [orderRows] = await query(
    'SELECT * FROM orders WHERE id = ? AND restaurant_id = ? LIMIT 1',
    [orderId, req.user.restaurantId]
  );
  if (!orderRows || orderRows.length === 0) return error(res, 'Order not found.', HTTP_STATUS.NOT_FOUND);
  const order = orderRows[0];

  await transaction(async (conn) => {
    await conn.execute(
      "UPDATE payments SET status = 'paid', gateway_payment_id = ? WHERE gateway_order_id = ? AND order_id = ?",
      [razorpayPaymentId, razorpayOrderId, orderId]
    );
    await conn.execute(
      "UPDATE orders SET status = 'completed', payment_status = 'paid', payment_mode = 'online', cashier_id = ?, completed_at = NOW() WHERE id = ?",
      [req.user.id, orderId]
    );
    if (order.table_id) {
      await conn.execute(
        "UPDATE tables SET status = 'available', current_order_id = NULL WHERE id = ? AND restaurant_id = ?",
        [order.table_id, req.user.restaurantId]
      );
    }
  });

  return success(res, null, 'Payment verified and order marked as paid.');
}

/* ─── Instamojo ────────────────────────────────────────────────────────────── */

async function createInstamojoPaymentLink(req, res) {
  const { orderId, buyerName, buyerEmail, buyerPhone } = req.body;

  const [orderRows] = await query(
    'SELECT * FROM orders WHERE id = ? AND restaurant_id = ? LIMIT 1',
    [orderId, req.user.restaurantId]
  );
  if (!orderRows || orderRows.length === 0) return error(res, 'Order not found.', HTTP_STATUS.NOT_FOUND);
  const order = orderRows[0];

  const [gwRows] = await query(
    "SELECT * FROM payment_gateway_settings WHERE restaurant_id = ? AND gateway = 'instamojo' AND is_active = 1 LIMIT 1",
    [req.user.restaurantId]
  );
  if (!gwRows || gwRows.length === 0) return error(res, 'Instamojo not configured.', HTTP_STATUS.BAD_REQUEST);

  const gw = gwRows[0];
  const baseUrl = gw.is_test_mode ? 'https://test.instamojo.com/api/1.1' : 'https://www.instamojo.com/api/1.1';
  const axios = require('axios');

  const response = await axios.post(
    `${baseUrl}/payment-requests/`,
    {
      purpose: `Order ${order.order_number}`,
      amount: order.total_amount.toFixed(2),
      buyer_name: buyerName || 'Guest',
      email: buyerEmail || '',
      phone: buyerPhone || '',
      redirect_url: `${process.env.FRONTEND_URL}/pos/payment-return?orderId=${orderId}`,
      allow_repeated_payments: false,
    },
    {
      headers: {
        'X-Api-Key': decrypt(gw.api_key_encrypted),
        'X-Auth-Token': decrypt(gw.api_secret_encrypted),
      },
    }
  );

  const data = response.data;
  await query(
    "INSERT INTO payments (order_id, restaurant_id, amount, payment_mode, gateway, gateway_order_id, status) VALUES (?, ?, ?, 'online', 'instamojo', ?, 'pending')",
    [orderId, req.user.restaurantId, order.total_amount, data.payment_request.id]
  );

  return success(res, { paymentUrl: data.payment_request.longurl });
}

/* ─── payment history ──────────────────────────────────────────────────────── */

async function getPayments(req, res) {
  const { page, limit, startDate, endDate, mode } = req.query;
  const parsedPage = parseInt(page) || 1;
  const parsedLimit = parseInt(limit) || 20;
  const offset = (parsedPage - 1) * parsedLimit;

  let where = 'WHERE p.restaurant_id = ?';
  const params = [req.user.restaurantId];
  if (startDate) { where += ' AND DATE(p.created_at) >= ?'; params.push(startDate); }
  if (endDate) { where += ' AND DATE(p.created_at) <= ?'; params.push(endDate); }
  if (mode) { where += ' AND p.payment_mode = ?'; params.push(mode); }

  const [countRows] = await query(`SELECT COUNT(*) AS total FROM payments p ${where}`, params);
  const [rows] = await query(
    `SELECT p.*, o.order_number FROM payments p
     LEFT JOIN orders o ON o.id = p.order_id
     ${where} ORDER BY p.created_at DESC LIMIT ? OFFSET ?`,
    [...params, parsedLimit, offset]
  );

  return success(res, { payments: rows, total: countRows[0].total, page: parsedPage });
}

module.exports = {
  getGatewaySettings, saveGatewaySettings,
  createRazorpayOrder, verifyRazorpayPayment,
  createInstamojoPaymentLink,
  getPayments,
};
