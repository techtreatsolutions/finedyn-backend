'use strict';

// Sanitize string: trim, collapse whitespace, strip control chars
function sanitize(str) {
  if (typeof str !== 'string') return str;
  return str.trim().replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '').replace(/\s+/g, ' ');
}

// Validate email format
function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

// Validate phone (Indian format, 10 digits after optional +91)
function isValidPhone(phone) {
  const clean = phone.replace(/[\s\-+]/g, '').replace(/^91/, '');
  return /^\d{10}$/.test(clean);
}

// Clamp integer to range
function clampInt(val, min, max, fallback) {
  const n = parseInt(val, 10);
  if (isNaN(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}

// Validate positive number
function isPositiveNumber(val) {
  const n = Number(val);
  return !isNaN(n) && n > 0 && isFinite(n);
}

// Validate non-negative number
function isNonNegativeNumber(val) {
  const n = Number(val);
  return !isNaN(n) && n >= 0 && isFinite(n);
}

// Validate string length
function isValidLength(str, min, max) {
  if (typeof str !== 'string') return false;
  return str.length >= min && str.length <= max;
}

// Sanitize pagination params — clamp page and limit to safe ranges
function sanitizePagination(query) {
  return {
    page: clampInt(query.page, 1, 10000, 1),
    limit: clampInt(query.limit, 1, 100, 20),
  };
}

module.exports = { sanitize, isValidEmail, isValidPhone, clampInt, isPositiveNumber, isNonNegativeNumber, isValidLength, sanitizePagination };
