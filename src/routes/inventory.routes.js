'use strict';

const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/auth');
const { requireRole } = require('../middleware/roleCheck');
const { requireFeature } = require('../middleware/featureCheck');
const ctrl = require('../controllers/inventory.controller');

const auth = [authenticate, requireFeature('feature_inventory')];
const mgr  = [authenticate, requireRole('owner', 'manager'), requireFeature('feature_inventory')];

router.get('/categories', ...auth, ctrl.getInventoryCategories);
router.post('/categories', ...mgr, ctrl.createInventoryCategory);
router.put('/categories/:categoryId', ...mgr, ctrl.updateInventoryCategory);
router.delete('/categories/:categoryId', ...mgr, ctrl.deleteInventoryCategory);

router.get('/items', ...auth, ctrl.getInventoryItems);
router.get('/items/:itemId', ...auth, ctrl.getInventoryItemById);
router.post('/items', ...mgr, ctrl.createInventoryItem);
router.put('/items/:itemId', ...mgr, ctrl.updateInventoryItem);
router.delete('/items/:itemId', ...mgr, ctrl.deleteInventoryItem);

router.post('/items/:itemId/stock-in', ...mgr, ctrl.stockIn);
router.post('/items/:itemId/stock-out', ...mgr, ctrl.stockOut);
router.get('/transactions', ...auth, ctrl.getTransactions);

router.get('/tickets', ...auth, ctrl.getTickets);
router.post('/tickets', ...auth, ctrl.createTicket);
router.patch('/tickets/:ticketId/status', ...mgr, ctrl.updateTicketStatus);

module.exports = router;
