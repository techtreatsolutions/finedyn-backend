'use strict';

const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/auth');
const { requireRole } = require('../middleware/roleCheck');
const ctrl = require('../controllers/floor.controller');

const auth = [authenticate];
const mgr = [authenticate, requireRole('owner', 'manager')];

router.get('/', ...auth, ctrl.getFloors);
router.post('/', ...mgr, ctrl.createFloor);
router.put('/:floorId', ...mgr, ctrl.updateFloor);
router.delete('/:floorId', ...mgr, ctrl.deleteFloor);
router.post('/reorder', ...mgr, ctrl.reorderFloors);

module.exports = router;
