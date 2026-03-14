'use strict';

const express = require('express');
const router = express.Router();
const { authenticate, optionalAuth } = require('../middleware/auth');
const { requireRole } = require('../middleware/roleCheck');
const ctrl = require('../controllers/menu.controller');
const { menuImageUpload } = require('../middleware/upload.middleware');

const auth = [authenticate];
const mgr = [authenticate, requireRole('owner', 'manager')];

router.get('/categories', optionalAuth, ctrl.getCategories); // Public for QR ordering, optionalAuth populates req.user when token present
router.post('/categories', ...mgr, ctrl.createCategory);
router.put('/categories/:categoryId', ...mgr, ctrl.updateCategory);
router.delete('/categories/:categoryId', ...mgr, ctrl.deleteCategory);
router.post('/categories/reorder', ...mgr, ctrl.reorderCategories);

router.get('/items', optionalAuth, ctrl.getMenuItems); // Public for QR ordering, optionalAuth populates req.user when token present
router.get('/items/:itemId', ...auth, ctrl.getMenuItemById);
router.post('/items', ...mgr, ctrl.createMenuItem);
router.put('/items/:itemId', ...mgr, ctrl.updateMenuItem);
router.patch('/items/:itemId/toggle', ...mgr, ctrl.toggleItemAvailability);
router.delete('/items/:itemId', ...mgr, ctrl.deleteMenuItem);

router.post('/items/upload-image', ...mgr, (req, res) => {
    menuImageUpload.single('image')(req, res, (err) => {
        if (err) {
            console.error('[Upload] Menu image error:', err);
            return res.status(500).json({ success: false, message: err.message || 'Upload failed.' });
        }
        if (!req.file) return res.status(400).json({ success: false, message: 'No file uploaded.' });
        res.json({ success: true, imageUrl: req.file.path });
    });
});

router.post('/items/:itemId/variants', ...mgr, ctrl.addVariant);
router.put('/items/:itemId/variants/:variantId', ...mgr, ctrl.updateVariant);
router.delete('/items/:itemId/variants/:variantId', ...mgr, ctrl.deleteVariant);

module.exports = router;
