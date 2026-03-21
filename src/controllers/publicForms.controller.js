'use strict';

const { query } = require('../config/database');
const { success, error } = require('../utils/responseHelper');
const { HTTP_STATUS } = require('../config/constants');

// ─── Public endpoints (no auth) ─────────────────────────────────────────

async function submitDemoRequest(req, res) {
  const { firstName, lastName, email, restaurantName } = req.body;
  if (!firstName || !email) return error(res, 'First name and email are required.', HTTP_STATUS.BAD_REQUEST);

  await query(
    'INSERT INTO demo_requests (first_name, last_name, email, restaurant_name) VALUES (?, ?, ?, ?)',
    [firstName.trim(), lastName?.trim() || null, email.trim(), restaurantName?.trim() || null]
  );
  return success(res, null, 'Demo request submitted successfully.', HTTP_STATUS.CREATED);
}

async function submitSupportRequest(req, res) {
  const { name, email, subject, message } = req.body;
  if (!name || !email || !subject || !message) return error(res, 'All fields are required.', HTTP_STATUS.BAD_REQUEST);

  await query(
    'INSERT INTO support_requests (name, email, subject, message) VALUES (?, ?, ?, ?)',
    [name.trim(), email.trim(), subject.trim(), message.trim()]
  );
  return success(res, null, 'Support request submitted successfully.', HTTP_STATUS.CREATED);
}

// ─── Super admin endpoints ──────────────────────────────────────────────

async function getDemoRequests(req, res) {
  const [rows] = await query('SELECT * FROM demo_requests ORDER BY created_at DESC');
  return success(res, rows || []);
}

async function updateDemoRequestStatus(req, res) {
  const { id } = req.params;
  const { status } = req.body;
  if (!['pending', 'resolved'].includes(status)) return error(res, 'Status must be pending or resolved.', HTTP_STATUS.BAD_REQUEST);
  await query('UPDATE demo_requests SET status = ? WHERE id = ?', [status, id]);
  return success(res, null, 'Status updated.');
}

async function deleteDemoRequest(req, res) {
  const { id } = req.params;
  await query('DELETE FROM demo_requests WHERE id = ?', [id]);
  return success(res, null, 'Demo request deleted.');
}

async function getSupportRequests(req, res) {
  const [rows] = await query('SELECT * FROM support_requests ORDER BY created_at DESC');
  return success(res, rows || []);
}

async function updateSupportRequestStatus(req, res) {
  const { id } = req.params;
  const { status } = req.body;
  if (!['pending', 'resolved'].includes(status)) return error(res, 'Status must be pending or resolved.', HTTP_STATUS.BAD_REQUEST);
  await query('UPDATE support_requests SET status = ? WHERE id = ?', [status, id]);
  return success(res, null, 'Status updated.');
}

async function deleteSupportRequest(req, res) {
  const { id } = req.params;
  await query('DELETE FROM support_requests WHERE id = ?', [id]);
  return success(res, null, 'Support request deleted.');
}

module.exports = { submitDemoRequest, submitSupportRequest, getDemoRequests, updateDemoRequestStatus, deleteDemoRequest, getSupportRequests, updateSupportRequestStatus, deleteSupportRequest };
