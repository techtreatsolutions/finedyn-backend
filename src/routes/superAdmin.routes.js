'use strict';

const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/auth');
const { requireRole } = require('../middleware/roleCheck');
const ctrl = require('../controllers/superAdmin.controller');

const sa = [authenticate, requireRole('super_admin')];

router.get('/dashboard', ...sa, ctrl.getDashboard);
router.get('/restaurants', ...sa, ctrl.getAllRestaurants);
router.post('/restaurants', ...sa, ctrl.createRestaurant);
router.get('/restaurants/:id', ...sa, ctrl.getRestaurantById);
router.get('/restaurants/:id/stats', ...sa, ctrl.getRestaurantStats);
router.put('/restaurants/:id', ...sa, ctrl.updateRestaurant);
router.patch('/restaurants/:id/status', ...sa, ctrl.toggleRestaurantStatus);
router.patch('/restaurants/:id/toggle', ...sa, ctrl.toggleRestaurantStatus); // alias
router.post('/restaurants/:id/renew', ...sa, ctrl.renewSubscription);
router.put('/restaurants/:id/update-plan', ...sa, ctrl.updateCurrentPlan);
router.post('/restaurants/:id/override', ...sa, ctrl.overrideFeature);
router.post('/restaurants/:id/overrides', ...sa, ctrl.overrideFeature); // alias
router.delete('/restaurants/:id/override/:featureName', ...sa, ctrl.removeOverride);
router.post('/restaurants/:id/overrides/remove', ...sa, ctrl.removeOverride); // alias
router.get('/plans', ...sa, ctrl.getAllPlans);
router.post('/plans', ...sa, ctrl.createPlan);
router.put('/plans/:id', ...sa, ctrl.updatePlan);
router.delete('/plans/:id', ...sa, ctrl.deletePlan);
router.get('/settlements', ...sa, ctrl.getSettlements);
router.post('/users/:userId/reset-password', ...sa, ctrl.resetUserPassword);

module.exports = router;
