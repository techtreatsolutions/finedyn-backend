'use strict';

const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/qr.controller');

// Public (no auth) — customer-facing
router.get('/:restaurantSlug/table/:tableId/info', ctrl.getTableInfo);
router.post('/:restaurantSlug/table/:tableId/verify-pin', ctrl.verifyTablePin);
router.get('/:restaurantSlug/table/:tableId/session', ctrl.validateSession);
router.post('/:restaurantSlug/table/:tableId/order', ctrl.placeQROrder);
router.get('/:restaurantSlug/table/:tableId/status', ctrl.getQROrderStatus);

module.exports = router;
