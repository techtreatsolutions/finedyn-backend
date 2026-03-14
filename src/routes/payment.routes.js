'use strict';

const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/auth');
const { requireRole } = require('../middleware/roleCheck');
const ctrl = require('../controllers/payment.controller');

const auth = [authenticate];
const mgr  = [authenticate, requireRole('owner', 'manager')];

router.get('/gateway-settings', ...mgr, ctrl.getGatewaySettings);
router.post('/gateway-settings', ...mgr, ctrl.saveGatewaySettings);

router.post('/razorpay/create-order', ...auth, ctrl.createRazorpayOrder);
router.post('/razorpay/verify', ...auth, ctrl.verifyRazorpayPayment);

router.post('/instamojo/create-link', ...auth, ctrl.createInstamojoPaymentLink);

router.get('/', ...mgr, ctrl.getPayments);

module.exports = router;
