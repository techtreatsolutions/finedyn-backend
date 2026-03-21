'use strict';

const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/auth');
const ctrl = require('../controllers/qr.controller');

const auth = [authenticate];

// POSS model staff endpoints
router.get('/pending', ...auth, ctrl.getPendingQROrders);
router.get('/my-pending', ...auth, ctrl.getMyPendingQROrders);
router.post('/:id/accept', ...auth, ctrl.acceptQROrder);
router.post('/:id/reject', ...auth, ctrl.rejectQROrder);

// QR model staff endpoints
router.get('/list', ...auth, ctrl.getQRModelOrders);
router.patch('/:id/update-status', ...auth, ctrl.updateQROrderStatus);
router.patch('/:id/payment', ...auth, ctrl.updateQROrderPayment);

module.exports = router;
