'use strict';

const QRCode = require('qrcode');
const { query } = require('../config/database');
const { success, error } = require('../utils/responseHelper');
const { HTTP_STATUS } = require('../config/constants');

async function getQRSettings(req, res) {
  const restaurantId = req.user.restaurantId;
  const [rows] = await query('SELECT * FROM qr_settings WHERE restaurant_id = ? LIMIT 1', [restaurantId]);
  if (rows && rows.length > 0) return success(res, rows[0]);
  // Return defaults
  return success(res, {
    restaurant_id: restaurantId,
    enable_dine_in: 1,
    enable_takeaway: 1,
    enable_delivery: 0,
    payment_acceptance: 'both',
    require_otp: 1,
    is_accepting_orders: 1,
  });
}

async function updateQRSettings(req, res) {
  const restaurantId = req.user.restaurantId;
  const { enableDineIn, enableTakeaway, enableDelivery, paymentAcceptance, requireOtp, isAcceptingOrders } = req.body;

  const validModes = ['online', 'counter', 'both'];
  const mode = validModes.includes(paymentAcceptance) ? paymentAcceptance : 'both';

  await query(
    `INSERT INTO qr_settings (restaurant_id, enable_dine_in, enable_takeaway, enable_delivery, payment_acceptance, require_otp, is_accepting_orders)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE enable_dine_in = VALUES(enable_dine_in), enable_takeaway = VALUES(enable_takeaway),
       enable_delivery = VALUES(enable_delivery), payment_acceptance = VALUES(payment_acceptance),
       require_otp = VALUES(require_otp), is_accepting_orders = VALUES(is_accepting_orders), updated_at = NOW()`,
    [restaurantId, enableDineIn ? 1 : 0, enableTakeaway ? 1 : 0, enableDelivery ? 1 : 0, mode, requireOtp !== false ? 1 : 0, isAcceptingOrders !== false ? 1 : 0]
  );
  return success(res, null, 'QR settings saved.');
}

async function generateStandaloneQR(req, res) {
  const restaurantId = req.user.restaurantId;
  const [rRows] = await query('SELECT slug FROM restaurants WHERE id = ? LIMIT 1', [restaurantId]);
  if (!rRows || rRows.length === 0) return error(res, 'Restaurant not found.', HTTP_STATUS.NOT_FOUND);

  const slug = rRows[0].slug;
  const frontendUrl = (process.env.FRONTEND_URL || 'http://localhost:3000').split(',')[0].trim();
  const qrUrl = `${frontendUrl}/qr/${slug}/order`;

  const qrDataUrl = await QRCode.toDataURL(qrUrl, {
    width: 400, margin: 2,
    color: { dark: '#000000', light: '#ffffff' },
  });

  return success(res, { qrCodeDataUrl: qrDataUrl, qrUrl }, 'QR code generated.');
}

module.exports = { getQRSettings, updateQRSettings, generateStandaloneQR };
