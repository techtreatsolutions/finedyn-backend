'use strict';

const express = require('express');
const rateLimit = require('express-rate-limit');
const router = express.Router();
const ctrl = require('../controllers/qr.controller');

// Rate limiters for public QR endpoints
const qrGeneralLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 60,
  standardHeaders: true, legacyHeaders: false,
  message: { success: false, message: 'Too many requests. Please try again later.' },
});

const qrOTPLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 5,
  standardHeaders: true, legacyHeaders: false,
  message: { success: false, message: 'Too many OTP requests. Please try again later.' },
});

const qrOrderLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 10,
  standardHeaders: true, legacyHeaders: false,
  message: { success: false, message: 'Too many order requests. Please try again later.' },
});

const qrPaymentLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 10,
  standardHeaders: true, legacyHeaders: false,
  message: { success: false, message: 'Too many payment requests. Please try again later.' },
});

// Public (no auth) — POSS model (table-based with PIN)
router.get('/:restaurantSlug/table/:tableId/info', qrGeneralLimiter, ctrl.getTableInfo);
router.post('/:restaurantSlug/table/:tableId/verify-pin', qrOTPLimiter, ctrl.verifyTablePin);
router.get('/:restaurantSlug/table/:tableId/session', qrGeneralLimiter, ctrl.validateSession);
router.post('/:restaurantSlug/table/:tableId/order', qrOrderLimiter, ctrl.placeQROrder);
router.get('/:restaurantSlug/table/:tableId/status', qrGeneralLimiter, ctrl.getQROrderStatus);

// Public (no auth) — QR model (no PIN, standalone ordering)
router.get('/:restaurantSlug/info', qrGeneralLimiter, ctrl.getQRRestaurantInfo);
router.get('/:restaurantSlug/floors-tables', qrGeneralLimiter, ctrl.getQRFloorsTables);
router.get('/:restaurantSlug/table-info', qrGeneralLimiter, ctrl.getQRTableInfo);
router.post('/:restaurantSlug/send-otp', qrOTPLimiter, ctrl.sendPhoneOTP);
router.post('/:restaurantSlug/verify-otp', qrOTPLimiter, ctrl.verifyPhoneOTP);
router.post('/:restaurantSlug/create-payment', qrPaymentLimiter, ctrl.createQRPayment);
router.post('/:restaurantSlug/verify-payment', qrPaymentLimiter, ctrl.verifyQRPayment);
router.post('/:restaurantSlug/refund-payment', qrPaymentLimiter, ctrl.refundQRPayment);
router.post('/:restaurantSlug/order', qrOrderLimiter, ctrl.placeQRModelOrder);
router.get('/:restaurantSlug/order-status', qrGeneralLimiter, ctrl.getQRModelOrderStatus);

module.exports = router;
