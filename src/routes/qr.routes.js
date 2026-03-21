'use strict';

const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/qr.controller');

// Public (no auth) — POSS model (table-based with PIN)
router.get('/:restaurantSlug/table/:tableId/info', ctrl.getTableInfo);
router.post('/:restaurantSlug/table/:tableId/verify-pin', ctrl.verifyTablePin);
router.get('/:restaurantSlug/table/:tableId/session', ctrl.validateSession);
router.post('/:restaurantSlug/table/:tableId/order', ctrl.placeQROrder);
router.get('/:restaurantSlug/table/:tableId/status', ctrl.getQROrderStatus);

// Public (no auth) — QR model (no PIN, standalone ordering)
router.get('/:restaurantSlug/info', ctrl.getQRRestaurantInfo);
router.get('/:restaurantSlug/floors-tables', ctrl.getQRFloorsTables);
router.get('/:restaurantSlug/table-info', ctrl.getQRTableInfo);
router.post('/:restaurantSlug/send-otp', ctrl.sendPhoneOTP);
router.post('/:restaurantSlug/verify-otp', ctrl.verifyPhoneOTP);
router.post('/:restaurantSlug/create-payment', ctrl.createQRPayment);
router.post('/:restaurantSlug/verify-payment', ctrl.verifyQRPayment);
router.post('/:restaurantSlug/refund-payment', ctrl.refundQRPayment);
router.post('/:restaurantSlug/order', ctrl.placeQRModelOrder);
router.get('/:restaurantSlug/order-status', ctrl.getQRModelOrderStatus);

module.exports = router;
