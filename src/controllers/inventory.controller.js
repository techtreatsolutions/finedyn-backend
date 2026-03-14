'use strict';

const { query, transaction } = require('../config/database');
const { success, error } = require('../utils/responseHelper');
const { HTTP_STATUS } = require('../config/constants');
const { checkFeature } = require('../utils/featureEngine');

/* ─── categories ───────────────────────────────────────────────────────────── */

async function getInventoryCategories(req, res) {
  const [rows] = await query(
    'SELECT * FROM inventory_categories WHERE restaurant_id = ? ORDER BY name ASC',
    [req.user.restaurantId]
  );
  return success(res, rows);
}

async function createInventoryCategory(req, res) {
  const allowed = await checkFeature(req.user.restaurantId, 'feature_inventory');
  if (!allowed) return error(res, 'Inventory feature not available on your plan.', HTTP_STATUS.FORBIDDEN, { upgradeRequired: true });

  const { name, unit } = req.body;
  if (!name) return error(res, 'name is required.', HTTP_STATUS.BAD_REQUEST);

  const [result] = await query(
    'INSERT INTO inventory_categories (restaurant_id, name, unit) VALUES (?, ?, ?)',
    [req.user.restaurantId, name, unit || 'unit']
  );
  return success(res, { id: result.insertId }, 'Category created.', HTTP_STATUS.CREATED);
}

async function updateInventoryCategory(req, res) {
  const { categoryId } = req.params;
  const { name, unit } = req.body;
  await query(
    'UPDATE inventory_categories SET name = COALESCE(?, name), unit = COALESCE(?, unit) WHERE id = ? AND restaurant_id = ?',
    [name || null, unit || null, categoryId, req.user.restaurantId]
  );
  return success(res, null, 'Category updated.');
}

async function deleteInventoryCategory(req, res) {
  const { categoryId } = req.params;
  const [items] = await query(
    'SELECT COUNT(*) AS cnt FROM inventory_items WHERE category_id = ? AND restaurant_id = ?',
    [categoryId, req.user.restaurantId]
  );
  if (items[0].cnt > 0) return error(res, 'Cannot delete category with items. Remove items first.', HTTP_STATUS.CONFLICT);
  await query('DELETE FROM inventory_categories WHERE id = ? AND restaurant_id = ?', [categoryId, req.user.restaurantId]);
  return success(res, null, 'Category deleted.');
}

/* ─── items ────────────────────────────────────────────────────────────────── */

async function getInventoryItems(req, res) {
  const { categoryId, lowStock } = req.query;
  let where = 'WHERE ii.restaurant_id = ?';
  const params = [req.user.restaurantId];
  if (categoryId) { where += ' AND ii.category_id = ?'; params.push(categoryId); }
  if (lowStock === 'true') { where += ' AND ii.current_stock <= ii.minimum_stock'; }

  const [rows] = await query(
    `SELECT ii.*, ii.minimum_stock AS min_stock_level, ic.name AS category_name
     FROM inventory_items ii
     LEFT JOIN inventory_categories ic ON ic.id = ii.category_id
     ${where}
     ORDER BY ii.name ASC`,
    params
  );
  return success(res, rows);
}

async function getInventoryItemById(req, res) {
  const { itemId } = req.params;
  const [rows] = await query(
    `SELECT ii.*, ii.minimum_stock AS min_stock_level, ic.name AS category_name
     FROM inventory_items ii
     LEFT JOIN inventory_categories ic ON ic.id = ii.category_id
     WHERE ii.id = ? AND ii.restaurant_id = ? LIMIT 1`,
    [itemId, req.user.restaurantId]
  );
  if (!rows || rows.length === 0) return error(res, 'Item not found.', HTTP_STATUS.NOT_FOUND);

  const [transactions] = await query(
    'SELECT * FROM inventory_transactions WHERE item_id = ? ORDER BY created_at DESC LIMIT 50',
    [itemId]
  );
  return success(res, { ...rows[0], recentTransactions: transactions });
}

async function createInventoryItem(req, res) {
  const allowed = await checkFeature(req.user.restaurantId, 'feature_inventory');
  if (!allowed) return error(res, 'Inventory feature not available on your plan.', HTTP_STATUS.FORBIDDEN, { upgradeRequired: true });

  const { name, categoryId, currentStock, minStockLevel, costPerUnit } = req.body;
  if (!name) return error(res, 'name is required.', HTTP_STATUS.BAD_REQUEST);

  const [result] = await query(
    'INSERT INTO inventory_items (restaurant_id, category_id, name, current_stock, minimum_stock, cost_per_unit) VALUES (?, ?, ?, ?, ?, ?)',
    [req.user.restaurantId, categoryId || null, name, currentStock || 0, minStockLevel || 0, costPerUnit || 0]
  );

  // Log initial stock
  const currentStockVal = parseFloat(currentStock) || 0;
  if (currentStockVal > 0) {
    await query(
      "INSERT INTO inventory_transactions (item_id, restaurant_id, transaction_type, quantity, previous_stock, new_stock, notes, performed_by) VALUES (?, ?, 'stock_in', ?, 0, ?, 'Initial stock', ?)",
      [result.insertId, req.user.restaurantId, currentStockVal, currentStockVal, req.user.id]
    );
  }

  return success(res, { id: result.insertId }, 'Item created.', HTTP_STATUS.CREATED);
}

async function updateInventoryItem(req, res) {
  const { itemId } = req.params;
  const { name, categoryId, minStockLevel, costPerUnit } = req.body;
  await query(
    `UPDATE inventory_items
     SET name = COALESCE(?, name),
         category_id = COALESCE(?, category_id),
         minimum_stock = COALESCE(?, minimum_stock),
         cost_per_unit = COALESCE(?, cost_per_unit)
     WHERE id = ? AND restaurant_id = ?`,
    [name || null, categoryId || null, minStockLevel ?? null, costPerUnit ?? null, itemId, req.user.restaurantId]
  );
  return success(res, null, 'Item updated.');
}

async function deleteInventoryItem(req, res) {
  const { itemId } = req.params;
  await query('DELETE FROM inventory_items WHERE id = ? AND restaurant_id = ?', [itemId, req.user.restaurantId]);
  return success(res, null, 'Item deleted.');
}

/* ─── stock transactions ───────────────────────────────────────────────────── */

async function stockIn(req, res) {
  const { itemId } = req.params;
  const { quantity, notes, costPerUnit } = req.body;
  if (!quantity || quantity <= 0) return error(res, 'Positive quantity required.', HTTP_STATUS.BAD_REQUEST);

  const [itemRows] = await query(
    'SELECT * FROM inventory_items WHERE id = ? AND restaurant_id = ? LIMIT 1',
    [itemId, req.user.restaurantId]
  );
  if (!itemRows || itemRows.length === 0) return error(res, 'Item not found.', HTTP_STATUS.NOT_FOUND);

  const prevStock = parseFloat(itemRows[0].current_stock);
  await transaction(async (conn) => {
    await conn.execute(
      'UPDATE inventory_items SET current_stock = current_stock + ?, cost_per_unit = COALESCE(?, cost_per_unit) WHERE id = ?',
      [quantity, costPerUnit || null, itemId]
    );
    await conn.execute(
      "INSERT INTO inventory_transactions (item_id, restaurant_id, transaction_type, quantity, previous_stock, new_stock, notes, performed_by) VALUES (?, ?, 'stock_in', ?, ?, ?, ?, ?)",
      [itemId, req.user.restaurantId, quantity, prevStock, prevStock + parseFloat(quantity), notes || null, req.user.id]
    );
  });

  return success(res, null, 'Stock added.');
}

async function stockOut(req, res) {
  const { itemId } = req.params;
  const { quantity, notes } = req.body;
  if (!quantity || quantity <= 0) return error(res, 'Positive quantity required.', HTTP_STATUS.BAD_REQUEST);

  const [itemRows] = await query(
    'SELECT * FROM inventory_items WHERE id = ? AND restaurant_id = ? LIMIT 1',
    [itemId, req.user.restaurantId]
  );
  if (!itemRows || itemRows.length === 0) return error(res, 'Item not found.', HTTP_STATUS.NOT_FOUND);
  if (itemRows[0].current_stock < quantity) return error(res, `Insufficient stock. Available: ${itemRows[0].current_stock}`, HTTP_STATUS.BAD_REQUEST);

  const prevStock = parseFloat(itemRows[0].current_stock);
  const newStock = prevStock - parseFloat(quantity);
  await transaction(async (conn) => {
    await conn.execute(
      'UPDATE inventory_items SET current_stock = current_stock - ? WHERE id = ?',
      [quantity, itemId]
    );
    await conn.execute(
      "INSERT INTO inventory_transactions (item_id, restaurant_id, transaction_type, quantity, previous_stock, new_stock, notes, performed_by) VALUES (?, ?, 'stock_out', ?, ?, ?, ?, ?)",
      [itemId, req.user.restaurantId, quantity, prevStock, newStock, notes || null, req.user.id]
    );
  });

  // Notify if stock fell below minimum level
  const minStock = parseFloat(itemRows[0].minimum_stock) || 0;
  if (newStock <= minStock && prevStock > minStock) {
    const { notifyRestaurantOwner } = require('./notification.controller');
    notifyRestaurantOwner(
      req.user.restaurantId, 'warning',
      `Low Stock Alert: ${itemRows[0].name}`,
      `${itemRows[0].name} stock is now ${newStock} (minimum: ${minStock}). Please restock soon.`
    ).catch(() => { });
  }

  return success(res, null, 'Stock removed.');
}

async function getTransactions(req, res) {
  const parsedPage = parseInt(page) || 1;
  const parsedLimit = parseInt(limit) || 50;
  const offset = (parsedPage - 1) * parsedLimit;

  let where = 'WHERE it.restaurant_id = ?';
  const params = [req.user.restaurantId];
  if (itemId) { where += ' AND it.item_id = ?'; params.push(itemId); }
  if (type) { where += ' AND it.transaction_type = ?'; params.push(type); }

  const [rows] = await query(
    `SELECT it.*, ii.name AS item_name, ii.unit, u.name AS performed_by_name
     FROM inventory_transactions it
     JOIN inventory_items ii ON ii.id = it.item_id
     LEFT JOIN users u ON u.id = it.performed_by
     ${where}
     ORDER BY it.created_at DESC
     LIMIT ? OFFSET ?`,
    [...params, parsedLimit, offset]
  );
  return success(res, rows);
}

/* ─── stock requirement tickets ────────────────────────────────────────────── */

async function getTickets(req, res) {
  const { status } = req.query;
  let where = 'WHERE t.restaurant_id = ?';
  const params = [req.user.restaurantId];
  if (status) { where += ' AND t.status = ?'; params.push(status); }

  const [rows] = await query(
    `SELECT t.*, ii.name AS item_name, ii.unit,
            u.name AS requested_by_name, a.name AS approved_by_name
     FROM stock_requirement_tickets t
     LEFT JOIN inventory_items ii ON ii.id = t.inventory_item_id
     LEFT JOIN users u ON u.id = COALESCE(t.requested_by, t.raised_by)
     LEFT JOIN users a ON a.id = t.approved_by
     ${where}
     ORDER BY t.created_at DESC`,
    params
  );
  return success(res, rows);
}

async function createTicket(req, res) {
  const { inventoryItemId, quantityRequested, priority, notes } = req.body;
  if (!inventoryItemId || !quantityRequested) return error(res, 'inventoryItemId and quantityRequested are required.', HTTP_STATUS.BAD_REQUEST);

  const [itemRows] = await query('SELECT name FROM inventory_items WHERE id = ? AND restaurant_id = ? LIMIT 1', [inventoryItemId, req.user.restaurantId]);
  if (!itemRows || itemRows.length === 0) return error(res, 'Inventory item not found.', HTTP_STATUS.NOT_FOUND);
  const itemName = itemRows[0].name;

  const [result] = await query(
    'INSERT INTO stock_requirement_tickets (restaurant_id, inventory_item_id, item_name, quantity_required, quantity_requested, priority, remarks, requested_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [req.user.restaurantId, inventoryItemId, itemName, String(quantityRequested), quantityRequested, priority || 'normal', notes || null, req.user.id]
  );

  // Notify restaurant owner about the stock request
  const { notifyRestaurantOwner } = require('./notification.controller');
  notifyRestaurantOwner(
    req.user.restaurantId, 'warning',
    `Stock Request: ${itemName}`,
    `${req.user.name || 'Staff'} raised a ${priority || 'normal'} priority request for ${quantityRequested} ${itemName}.`
  ).catch(() => { });

  return success(res, { id: result.insertId }, 'Ticket raised.', HTTP_STATUS.CREATED);
}

async function updateTicketStatus(req, res) {
  const { ticketId } = req.params;
  const { status, notes } = req.body;
  const validStatuses = ['pending', 'approved', 'rejected', 'fulfilled'];
  if (!validStatuses.includes(status)) return error(res, 'Invalid status.', HTTP_STATUS.BAD_REQUEST);

  const [rows] = await query(
    'SELECT * FROM stock_requirement_tickets WHERE id = ? AND restaurant_id = ? LIMIT 1',
    [ticketId, req.user.restaurantId]
  );
  if (!rows || rows.length === 0) return error(res, 'Ticket not found.', HTTP_STATUS.NOT_FOUND);

  await transaction(async (conn) => {
    await conn.execute(
      'UPDATE stock_requirement_tickets SET status = ?, approved_by = ?, manager_notes = ? WHERE id = ?',
      [status, req.user.id, notes || null, ticketId]
    );

    // If fulfilled, automatically stock in
    if (status === 'fulfilled' && rows[0].inventory_item_id) {
      const qty = rows[0].quantity_requested || rows[0].quantity_required || 0;
      const [[itemRow]] = await conn.execute(
        'SELECT current_stock FROM inventory_items WHERE id = ? LIMIT 1',
        [rows[0].inventory_item_id]
      );
      const prevStockTicket = parseFloat(itemRow ? itemRow.current_stock : 0);
      await conn.execute(
        'UPDATE inventory_items SET current_stock = current_stock + ? WHERE id = ?',
        [qty, rows[0].inventory_item_id]
      );
      await conn.execute(
        "INSERT INTO inventory_transactions (item_id, restaurant_id, transaction_type, quantity, previous_stock, new_stock, notes, performed_by) VALUES (?, ?, 'stock_in', ?, ?, ?, 'Fulfilled via ticket', ?)",
        [rows[0].inventory_item_id, req.user.restaurantId, qty, prevStockTicket, prevStockTicket + parseFloat(qty), req.user.id]
      );
    }
  });

  return success(res, null, 'Ticket updated.');
}

module.exports = {
  getInventoryCategories, createInventoryCategory, updateInventoryCategory, deleteInventoryCategory,
  getInventoryItems, getInventoryItemById, createInventoryItem, updateInventoryItem, deleteInventoryItem,
  stockIn, stockOut, getTransactions,
  getTickets, createTicket, updateTicketStatus,
};
