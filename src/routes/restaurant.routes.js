'use strict';

const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/auth');
const { requireRole } = require('../middleware/roleCheck');
const ctrl = require('../controllers/restaurant.controller');
const qrSettingsCtrl = require('../controllers/qrSettings.controller');

const { upload, billImageUpload, deleteCloudinaryImage } = require('../middleware/upload.middleware');
const { query } = require('../config/database');

const auth = [authenticate];
const ownerManager = [authenticate, requireRole('owner', 'manager')];
const ownerOnly = [authenticate, requireRole('owner')];

router.get('/profile', ...auth, ctrl.getRestaurantProfile);
router.put('/profile', ...ownerOnly, ctrl.updateRestaurantProfile);
router.post('/upload-logo', ...ownerOnly, async (req, res, next) => {
    // Fetch old logo URL before uploading
    const [rows] = await query('SELECT logo_url FROM restaurants WHERE id = ? LIMIT 1', [req.user.restaurantId]);
    const oldLogoUrl = rows?.[0]?.logo_url;

    upload.single('logo')(req, res, async (err) => {
        if (err) {
            console.error('[Upload] Error during file upload:', err);
            return res.status(500).json({ success: false, message: err.message || 'Server error during upload.' });
        }
        if (!req.file) return res.status(400).json({ success: false, message: 'No file uploaded.' });
        // Delete old logo from Cloudinary
        if (oldLogoUrl) deleteCloudinaryImage(oldLogoUrl).catch(() => {});
        res.json({ success: true, imageUrl: req.file.path });
    });
});
router.get('/subscription', ...auth, ctrl.getSubscriptionInfo);
router.get('/dashboard-stats', ...auth, ctrl.getDashboardStats);
router.get('/dashboard', ...auth, ctrl.getDashboardStats); // alias
router.get('/users', ...ownerManager, ctrl.getUsers);
router.post('/users', ...ownerManager, ctrl.createUser);
router.put('/users/:userId', ...ownerManager, ctrl.updateUser);
router.delete('/users/:userId', ...ownerManager, ctrl.deleteUser);
router.post('/users/:userId/reset-password', ...ownerManager, ctrl.resetStaffPassword);
router.get('/bill-format', ...auth, ctrl.getBillFormatSettings);
router.put('/bill-format', ...ownerManager, ctrl.updateBillFormatSettings);
router.post('/bill-format/upload-image/:type', ...ownerManager, async (req, res) => {
    const type = req.params.type;
    if (!['header', 'footer'].includes(type)) {
        return res.status(400).json({ success: false, message: 'Type must be header or footer.' });
    }
    // Fetch old image URL before uploading
    const col = type === 'header' ? 'header_image_url' : 'footer_image_url';
    const [rows] = await query(`SELECT ${col} FROM bill_format_settings WHERE restaurant_id = ? LIMIT 1`, [req.user.restaurantId]);
    const oldImageUrl = rows?.[0]?.[col];

    billImageUpload.single('image')(req, res, async (err) => {
        if (err) {
            console.error('[Upload] Bill image error:', err);
            return res.status(500).json({ success: false, message: err.message || 'Upload failed.' });
        }
        if (!req.file) return res.status(400).json({ success: false, message: 'No file uploaded.' });
        if (oldImageUrl) deleteCloudinaryImage(oldImageUrl).catch(() => {});
        res.json({ success: true, imageUrl: req.file.path });
    });
});

// WA Messaging Settings
router.get('/wa-messaging-settings', ...ownerManager, ctrl.getWAMessagingSettings);
router.put('/wa-messaging-settings', ...ownerOnly, ctrl.updateWAMessagingSettings);

// QR Settings
router.get('/qr-settings', ...ownerManager, qrSettingsCtrl.getQRSettings);
router.put('/qr-settings', ...ownerManager, qrSettingsCtrl.updateQRSettings);
router.post('/generate-standalone-qr', ...ownerManager, qrSettingsCtrl.generateStandaloneQR);

module.exports = router;
