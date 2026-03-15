'use strict';

const jwt = require('jsonwebtoken');
const crypto = require('crypto');

const JWT_SECRET = process.env.JWT_SECRET || 'fallback_secret_change_in_production';
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '30d';
const JWT_REFRESH_EXPIRES_IN = process.env.JWT_REFRESH_EXPIRES_IN || '30d';

function generateAccessToken(payload) {
  return jwt.sign(
    {
      id: payload.id,
      email: payload.email,
      role: payload.role,
      restaurantId: payload.restaurantId || null,
      name: payload.name,
      type: 'access',
      sid: payload.sessionId || null,
    },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES_IN, issuer: 'finedyn', audience: 'finedyn-client' }
  );
}

function generateRefreshToken(payload) {
  return jwt.sign(
    { id: payload.id, email: payload.email, type: 'refresh' },
    JWT_SECRET,
    { expiresIn: JWT_REFRESH_EXPIRES_IN, issuer: 'finedyn', audience: 'finedyn-client' }
  );
}

function verifyToken(token) {
  return jwt.verify(token, JWT_SECRET, {
    issuer: 'finedyn',
    audience: 'finedyn-client',
  });
}

function generatePasswordResetToken(userId) {
  const resetSecret = JWT_SECRET + '-reset';
  return jwt.sign(
    { id: userId, type: 'password_reset', jti: crypto.randomBytes(16).toString('hex') },
    resetSecret,
    { expiresIn: '1h', issuer: 'finedyn', audience: 'finedyn-reset' }
  );
}

function verifyPasswordResetToken(token) {
  const resetSecret = JWT_SECRET + '-reset';
  return jwt.verify(token, resetSecret, { issuer: 'finedyn', audience: 'finedyn-reset' });
}

module.exports = {
  generateAccessToken,
  generateRefreshToken,
  verifyToken,
  generatePasswordResetToken,
  verifyPasswordResetToken,
};
