'use strict';

const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/auth');
const { requireRole } = require('../middleware/roleCheck');
const { requireFeature } = require('../middleware/featureCheck');
const ctrl = require('../controllers/reservation.controller');

const auth = [authenticate, requireFeature('feature_reservations')];
const mgr  = [authenticate, requireRole('owner', 'manager'), requireFeature('feature_reservations')];

router.get('/', ...auth, ctrl.getReservations);
router.get('/available-tables', ...auth, ctrl.getAvailableTables);
router.get('/check-upcoming', ...auth, ctrl.checkUpcomingReservations);
router.get('/:reservationId', ...auth, ctrl.getReservationById);
router.post('/', ...auth, ctrl.createReservation);
router.post('/:reservationId/start-order', ...auth, ctrl.startOrderFromReservation);
router.put('/:reservationId', ...auth, ctrl.updateReservation);
router.patch('/:reservationId/status', ...auth, ctrl.updateReservationStatus);
router.delete('/:reservationId', ...mgr, ctrl.deleteReservation);

module.exports = router;
