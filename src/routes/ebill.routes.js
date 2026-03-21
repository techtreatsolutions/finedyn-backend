'use strict';

const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/order.controller');

// Public (no auth) — e-bill access
router.post('/:token/verify', ctrl.verifyEBill);
router.get('/:token/data', ctrl.getEBillData);

module.exports = router;
