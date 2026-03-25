'use strict';

const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/auth');
const ctrl = require('../controllers/auth.controller');

router.post('/login', ctrl.login);
router.post('/pin-login', ctrl.pinLogin);
router.post('/register', ctrl.register);
router.post('/logout', authenticate, ctrl.logout);
router.post('/forgot-password', ctrl.forgotPassword);
router.post('/reset-password', ctrl.resetPassword);
router.get('/profile', authenticate, ctrl.getProfile);
router.put('/profile', authenticate, ctrl.updateProfile);
router.post('/change-password', authenticate, ctrl.changePassword);
router.post('/register-device', authenticate, ctrl.registerDevice);
router.post('/unregister-device', authenticate, ctrl.unregisterDevice);
router.get('/check-app-version', ctrl.checkAppVersion);

module.exports = router;
