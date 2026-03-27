'use strict';

const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/auth');
const ctrl = require('../controllers/auth.controller');

const rateLimit = require('express-rate-limit');
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 3,
  skipSuccessfulRequests: true,
  standardHeaders: true, legacyHeaders: false,
  message: { success: false, message: 'Too many failed login attempts. Try again in 15 minutes.' },
});

router.post('/login', loginLimiter, ctrl.login);
router.post('/pin-login', loginLimiter, ctrl.pinLogin);
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
