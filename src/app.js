'use strict';

require('dotenv').config();
require('express-async-errors');

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const compression = require('compression');
const rateLimit = require('express-rate-limit');
const bcrypt = require('bcryptjs');

const { testConnection, query } = require('./config/database');
const { error: errorResponse } = require('./utils/responseHelper');
const { HTTP_STATUS, ROLES } = require('./config/constants');

// Route imports
const authRoutes = require('./routes/auth.routes');
const superAdminRoutes = require('./routes/superAdmin.routes');
const restaurantRoutes = require('./routes/restaurant.routes');
const floorRoutes = require('./routes/floor.routes');
const tableRoutes = require('./routes/table.routes');
const menuRoutes = require('./routes/menu.routes');
const orderRoutes = require('./routes/order.routes');
const paymentRoutes = require('./routes/payment.routes');
const inventoryRoutes = require('./routes/inventory.routes');
const expenseRoutes = require('./routes/expense.routes');
const employeeRoutes = require('./routes/employee.routes');
const reportRoutes = require('./routes/report.routes');
const reservationRoutes = require('./routes/reservation.routes');
const notificationRoutes = require('./routes/notification.routes');
const qrRoutes = require('./routes/qr.routes');
const qrOrderRoutes = require('./routes/qrOrders.routes');
const ebillRoutes = require('./routes/ebill.routes');
const publicFormsRoutes = require('./routes/publicForms.routes');

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');

// Security
app.use(helmet({
  crossOriginResourcePolicy: { policy: 'cross-origin' },
  contentSecurityPolicy: false,
  hsts: { maxAge: 31536000, includeSubDomains: true },
}));

// CORS
const allowedOrigins = (process.env.FRONTEND_URL || 'http://localhost:3000').split(',').map(o => o.trim());
app.use(cors({
  origin(origin, callback) {
    if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
    callback(new Error(`CORS policy: origin "${origin}" not allowed.`));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

// Middleware
app.use(compression());
if (process.env.NODE_ENV !== 'test') app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true, limit: '2mb' }));

// Rate limiting — only on sensitive endpoints, not globally (POS apps make thousands of requests per day)
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 15,
  standardHeaders: true, legacyHeaders: false,
  message: { success: false, message: 'Too many auth attempts. Try again in 15 minutes.' },
});
const publicLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 60,
  standardHeaders: true, legacyHeaders: false,
  message: { success: false, message: 'Too many requests.' },
});

// Health (both /health and /api/health for compatibility)
async function healthHandler(req, res) {
  try {
    await query('SELECT 1');
    res.send(true);
  } catch {
    res.status(503).json({ success: false, message: 'Database unavailable' });
  }
}
app.get('/health', healthHandler);
app.get('/api/health', healthHandler);

// Routes
app.use('/api/auth', authLimiter, authRoutes);
app.use('/api/super-admin', superAdminRoutes);
app.use('/api/restaurant', restaurantRoutes);
app.use('/api/floors', floorRoutes);
app.use('/api/tables', tableRoutes);
app.use('/api/menu', menuRoutes);
app.use('/api/orders', orderRoutes);
app.use('/api/payments', paymentRoutes);
app.use('/api/inventory', inventoryRoutes);
app.use('/api/expenses', expenseRoutes);
app.use('/api/employees', employeeRoutes);
app.use('/api/reports', reportRoutes);
app.use('/api/reservations', reservationRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/qr', qrRoutes);
app.use('/api/qr-orders', qrOrderRoutes);
app.use('/api/ebill', publicLimiter, ebillRoutes);
app.use('/api/public', publicLimiter, publicFormsRoutes);

// 404
app.use((req, res) => errorResponse(res, `Route not found: ${req.method} ${req.originalUrl}`, HTTP_STATUS.NOT_FOUND));

// Global error handler
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err.message?.startsWith('CORS')) return errorResponse(res, err.message, HTTP_STATUS.FORBIDDEN);
  if (err.type === 'entity.parse.failed') return errorResponse(res, 'Invalid JSON.', HTTP_STATUS.BAD_REQUEST);
  console.error(`[Error] ${new Date().toISOString()} ${req.method} ${req.originalUrl}`, err.stack || err.message);
  const statusCode = err.statusCode || err.status || HTTP_STATUS.INTERNAL_SERVER_ERROR;
  const message = process.env.NODE_ENV === 'production' ? 'An internal server error occurred.' : err.message;
  return errorResponse(res, message, statusCode);
});

// Seed super admin
async function seedSuperAdmin() {
  const email = process.env.SUPER_ADMIN_EMAIL || 'superadmin@finedyn.com';
  const password = process.env.SUPER_ADMIN_PASSWORD || 'SuperAdmin@123';
  try {
    const [rows] = await query('SELECT id FROM users WHERE role = ? LIMIT 1', [ROLES.SUPER_ADMIN]);
    if (rows && rows.length > 0) { console.log('[Seed] Super admin exists.'); return; }
    const hash = await bcrypt.hash(password, 12);
    await query(
      'INSERT INTO users (name, email, password_hash, role, is_active, is_verified) VALUES (?, ?, ?, ?, 1, 1)',
      ['Super Admin', email, hash, ROLES.SUPER_ADMIN]
    );
    console.log(`[Seed] Super admin created: ${email}`);
  } catch (err) {
    console.warn('[Seed] Could not seed super admin (run migrations first):', err.message);
  }
}

const PORT = parseInt(process.env.PORT, 10) || 5000;

async function startServer() {
  try {
    await testConnection();
    await seedSuperAdmin();
    app.listen(PORT, () => {
      console.log('\n  ╔══════════════════════════════════╗');
      console.log('  ║       FineDyn Backend Server     ║');
      console.log(`  ║  Port: ${PORT}  ENV: ${(process.env.NODE_ENV || 'dev').padEnd(12)}║`);
      console.log(`  ║  URL: http://localhost:${PORT}       ║`);
      console.log('  ╚══════════════════════════════════╝\n');
    });
  } catch (err) {
    console.error('[Startup] Failed:', err.message);
    process.exit(1);
  }
}

startServer();
module.exports = app;
