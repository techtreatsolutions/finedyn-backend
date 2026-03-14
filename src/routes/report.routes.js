'use strict';

const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/auth');
const { requireRole } = require('../middleware/roleCheck');
const { requireFeature } = require('../middleware/featureCheck');
const ctrl = require('../controllers/report.controller');

const mgr = [authenticate, requireRole('owner', 'manager'), requireFeature('feature_analytics')];

router.get('/sales', ...mgr, ctrl.getSalesSummary);
router.get('/items', ...mgr, ctrl.getItemWiseReport);
router.get('/categories', ...mgr, ctrl.getCategoryWiseReport);
router.get('/payment-modes', ...mgr, ctrl.getPaymentModeReport);
router.get('/waiters', ...mgr, ctrl.getWaiterReport);
router.get('/tax', ...mgr, ctrl.getTaxReport);
router.get('/hourly', ...mgr, ctrl.getHourlyReport);
router.get('/expenses', ...mgr, ctrl.getExpenseReport);

module.exports = router;
