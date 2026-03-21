'use strict';

const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/publicForms.controller');

// Public — no auth required
router.post('/demo-request', ctrl.submitDemoRequest);
router.post('/support-request', ctrl.submitSupportRequest);

module.exports = router;
