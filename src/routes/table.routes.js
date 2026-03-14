'use strict';

const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/auth');
const { requireRole } = require('../middleware/roleCheck');
const ctrl = require('../controllers/table.controller');
const qrCtrl = require('../controllers/qr.controller');

const auth = [authenticate];
const mgr = [authenticate, requireRole('owner', 'manager')];

router.get('/', ...auth, ctrl.getTables);
router.get('/my-tables', ...auth, ctrl.getMyTables);
router.get('/:tableId', ...auth, ctrl.getTableById);
router.post('/', ...mgr, ctrl.createTable);
router.put('/:tableId', ...mgr, ctrl.updateTable);
router.delete('/:tableId', ...mgr, ctrl.deleteTable);
router.patch('/:tableId/assign-waiter', ...auth, ctrl.assignWaiter);
router.patch('/:tableId/status', ...auth, ctrl.updateTableStatus);
router.get('/floor/:floorId/map', ...auth, ctrl.getTableMapForFloor);
router.get('/waiters/list', ...auth, ctrl.getWaiters);

// QR code management
router.post('/:tableId/generate-qr', ...mgr, qrCtrl.generateTableQR);
router.post('/:tableId/reset-session', ...mgr, qrCtrl.resetTableSession);
router.post('/:tableId/waiter-reset-session', ...auth, ctrl.waiterResetSession);
router.get('/:tableId/qr-download', ...mgr, qrCtrl.downloadTableQR);

module.exports = router;
