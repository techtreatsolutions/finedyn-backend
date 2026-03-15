'use strict';

const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/auth');
const { requireRole } = require('../middleware/roleCheck');
const { requireFeature } = require('../middleware/featureCheck');
const ctrl = require('../controllers/order.controller');

const auth = [authenticate];
const mgr = [authenticate, requireRole('owner', 'manager')];
const cashier = [authenticate, requireRole('owner', 'manager', 'cashier')];

// --- Specific/static routes MUST come before parameterized /:orderId routes ---
router.get('/', ...auth, ctrl.getOrders);
const kds = [authenticate, requireRole('owner', 'manager', 'cashier', 'kitchen_staff'), requireFeature('feature_kds')];
router.get('/kitchen', ...kds, ctrl.getKitchenOrders);
router.patch('/kitchen/items/:itemId/status', ...kds, ctrl.updateKitchenItemStatus);
router.get('/customers', ...auth, ctrl.getCustomers);
router.get('/customers/:phone/history', ...auth, ctrl.getCustomerOrders);
router.get('/customer/:phone', ...auth, ctrl.getCustomerByPhone);
router.post('/', ...auth, ctrl.createOrder);

// --- Parameterized routes ---
router.get('/:orderId', ...auth, ctrl.getOrderById);
router.get('/:orderId/payments', ...auth, ctrl.getOrderPayments);
router.post('/:orderId/items', ...auth, ctrl.addOrderItems);
router.put('/:orderId/items/:itemId', ...auth, ctrl.updateOrderItem);
router.delete('/:orderId/items/:itemId', ...auth, ctrl.removeOrderItem);

router.post('/:orderId/kot', ...auth, ctrl.sendKOT);
router.post('/:orderId/adjustments', ...auth, ctrl.addBillAdjustment);
router.delete('/:orderId/adjustments/:adjustmentId', ...auth, ctrl.removeBillAdjustment);

router.post('/:orderId/pay', ...cashier, ctrl.markOrderPaid);
router.post('/:orderId/payments', ...auth, ctrl.addOrderPayment);
router.post('/:orderId/close', ...auth, ctrl.closeOrder);
router.post('/:orderId/reopen', ...auth, ctrl.reopenOrder);
router.post('/:orderId/cancel', ...auth, ctrl.cancelOrder);
router.get('/:orderId/bill', ...auth, ctrl.generateBill);
router.patch('/:orderId/customer', ...auth, ctrl.updateOrderCustomer);

module.exports = router;
