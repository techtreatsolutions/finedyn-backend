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
router.get('/wa-tokens', ...sa, ctrl.getWATokens);
router.post('/wa-tokens', ...sa, ctrl.updateWATokens);
router.get('/wa-tokens/:id/history', ...sa, ctrl.getWATokenHistory);

// App Update Settings
router.get('/app-update', ...sa, ctrl.getAppUpdateSettings);
router.put('/app-update', ...sa, ctrl.updateAppUpdateSettings);

// Broadcast Notifications
router.post('/send-notification', ...sa, ctrl.sendBroadcastNotification);
router.get('/search-targets', ...sa, ctrl.searchNotificationTargets);

// Demo & Support requests
const formCtrl = require('../controllers/publicForms.controller');
router.get('/demo-requests', ...sa, formCtrl.getDemoRequests);
router.patch('/demo-requests/:id/status', ...sa, formCtrl.updateDemoRequestStatus);
router.delete('/demo-requests/:id', ...sa, formCtrl.deleteDemoRequest);
router.get('/support-requests', ...sa, formCtrl.getSupportRequests);
router.patch('/support-requests/:id/status', ...sa, formCtrl.updateSupportRequestStatus);
router.delete('/support-requests/:id', ...sa, formCtrl.deleteSupportRequest);

module.exports = router;
