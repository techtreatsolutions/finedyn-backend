'use strict';

const { query } = require('../config/database');
const { success, error } = require('../utils/responseHelper');
const { HTTP_STATUS } = require('../config/constants');
const { checkLimit } = require('../utils/featureEngine');

async function getFloors(req, res) {
  const [rows] = await query(
    `SELECT f.*, COUNT(t.id) AS table_count,
      COUNT(CASE WHEN t.status = 'available' THEN 1 END) AS available_count,
      COUNT(CASE WHEN t.status = 'occupied' THEN 1 END) AS occupied_count
     FROM floors f LEFT JOIN tables t ON t.floor_id = f.id AND t.is_active = 1
     WHERE f.restaurant_id = ? AND f.is_active = 1 GROUP BY f.id ORDER BY f.sort_order ASC, f.name ASC`,
    [req.user.restaurantId]
  );
  return success(res, rows);
}

async function createFloor(req, res) {
  const { name, description } = req.body;
  if (!name) return error(res, 'Floor name is required.', HTTP_STATUS.BAD_REQUEST);

  const [countRows] = await query('SELECT COUNT(*) AS count FROM floors WHERE restaurant_id = ? AND is_active = 1', [req.user.restaurantId]);
  const limitCheck = await checkLimit(req.user.restaurantId, 'max_floors', countRows[0].count);
  if (!limitCheck.allowed) return error(res, `Floor limit reached (${limitCheck.limit}). Upgrade your plan.`, HTTP_STATUS.FORBIDDEN, { upgradeRequired: true });

  const [result] = await query(
    'INSERT INTO floors (restaurant_id, name, description) VALUES (?, ?, ?)',
    [req.user.restaurantId, name.trim(), description || null]
  );
  return success(res, { id: result.insertId }, 'Floor created.', HTTP_STATUS.CREATED);
}

async function updateFloor(req, res) {
  const { floorId } = req.params;
  const { name, description } = req.body;
  await query(
    'UPDATE floors SET name = COALESCE(?, name), description = COALESCE(?, description) WHERE id = ? AND restaurant_id = ?',
    [name || null, description || null, floorId, req.user.restaurantId]
  );
  return success(res, null, 'Floor updated.');
}

async function deleteFloor(req, res) {
  const { floorId } = req.params;
  const [tables] = await query('SELECT COUNT(*) AS count FROM tables WHERE floor_id = ? AND restaurant_id = ?', [floorId, req.user.restaurantId]);
  if (tables[0].count > 0) return error(res, 'Cannot delete floor with tables. Delete tables first.', HTTP_STATUS.BAD_REQUEST);
  await query('UPDATE floors SET is_active = 0 WHERE id = ? AND restaurant_id = ?', [floorId, req.user.restaurantId]);
  return success(res, null, 'Floor deleted.');
}

async function reorderFloors(req, res) {
  const { order } = req.body;
  if (!Array.isArray(order)) return error(res, 'order must be an array.', HTTP_STATUS.BAD_REQUEST);
  for (const item of order) {
    await query('UPDATE floors SET sort_order = ? WHERE id = ? AND restaurant_id = ?', [item.sortOrder, item.id, req.user.restaurantId]);
  }
  return success(res, null, 'Floors reordered.');
}

module.exports = { getFloors, createFloor, updateFloor, deleteFloor, reorderFloors };
