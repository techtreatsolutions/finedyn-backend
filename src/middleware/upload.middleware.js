'use strict';

const cloudinary = require('cloudinary').v2;
const { CloudinaryStorage } = require('multer-storage-cloudinary');
const multer = require('multer');

// Configure Cloudinary
cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
});

// Setup Cloudinary Storage for Multer
const storage = new CloudinaryStorage({
    cloudinary: cloudinary,
    params: {
        folder: 'finedyn/logos',
        allowed_formats: ['jpg', 'png', 'jpeg', 'webp', 'avif'],
        public_id: (req, file) => {
            console.log('[Upload] Processing file for restaurant:', req.user?.restaurantId);
            if (!req.user || !req.user.restaurantId) {
                console.error('[Upload] Error: req.user or restaurantId missing');
                throw new Error('Authentication context missing for upload');
            }
            return `logo_${req.user.restaurantId}_${Date.now()}`;
        },
    },
});

const billImageStorage = new CloudinaryStorage({
    cloudinary: cloudinary,
    params: {
        folder: 'finedyn/bill-images',
        allowed_formats: ['jpg', 'png', 'jpeg', 'webp', 'avif'],
        public_id: (req, file) => {
            if (!req.user || !req.user.restaurantId) {
                throw new Error('Authentication context missing for upload');
            }
            const type = req.params.type || 'bill';
            return `${type}_${req.user.restaurantId}_${Date.now()}`;
        },
    },
});

const menuImageStorage = new CloudinaryStorage({
    cloudinary: cloudinary,
    params: {
        folder: 'finedyn/menu-items',
        allowed_formats: ['jpg', 'png', 'jpeg', 'webp', 'avif'],
        public_id: (req, file) => {
            if (!req.user || !req.user.restaurantId) {
                throw new Error('Authentication context missing for upload');
            }
            return `item_${req.user.restaurantId}_${Date.now()}`;
        },
    },
});

const upload = multer({ storage: storage });
const billImageUpload = multer({ storage: billImageStorage });
const menuImageUpload = multer({ storage: menuImageStorage });

module.exports = { upload, billImageUpload, menuImageUpload };
