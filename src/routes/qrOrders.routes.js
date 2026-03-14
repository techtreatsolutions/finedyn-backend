'use strict';

const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/auth');
const ctrl = require('../controllers/qr.controller');

const auth = [authenticate];

router.get('/pending', ...auth, ctrl.getPendingQROrders);
router.get('/my-pending', ...auth, ctrl.getMyPendingQROrders);
router.post('/:id/accept', ...auth, ctrl.acceptQROrder);
router.post('/:id/reject', ...auth, ctrl.rejectQROrder);

module.exports = router;
