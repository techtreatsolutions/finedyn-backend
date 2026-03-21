'use strict';

const { query, transaction } = require('../config/database');
const { success, error } = require('../utils/responseHelper');
const { HTTP_STATUS } = require('../config/constants');
const { checkLimit } = require('../utils/featureEngine');

// CATEGORIES
async function getCategories(req, res) {
  try {
    let rId = req.user?.restaurantId;
    if (!rId && req.query.restaurantSlug) {
      const [r] = await query('SELECT id FROM restaurants WHERE slug = ? AND is_active = 1 LIMIT 1', [req.query.restaurantSlug]);
      rId = r?.[0]?.id;
    }
    if (!rId && req.query.restaurantId) rId = req.query.restaurantId;
    if (!rId) return success(res, []);
    const { available } = req.query;
    let timeFilter = '';
    if (available === 'true') {
      timeFilter = 'AND (c.available_from IS NULL OR c.available_to IS NULL OR CURTIME() BETWEEN c.available_from AND c.available_to)';
    }
    const [rows] = await query(
      `SELECT c.*, COUNT(mi.id) AS item_count FROM menu_categories c
       LEFT JOIN menu_items mi ON mi.category_id = c.id AND mi.is_available = 1
       WHERE c.restaurant_id = ? AND c.is_active = 1
       ${timeFilter}
       GROUP BY c.id ORDER BY c.sort_order ASC, c.name ASC`,
      [rId]
    );
    return success(res, rows);
  } catch (err) {
    console.error('[Menu] getCategories error:', err);
    return error(res, 'Internal server error while fetching categories.', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
}

async function createCategory(req, res) {
  try {
    const { name, description, availableFrom, availableTo } = req.body;
    if (!name) return error(res, 'Category name is required.', HTTP_STATUS.BAD_REQUEST);
    const [result] = await query(
      'INSERT INTO menu_categories (restaurant_id, name, description, available_from, available_to) VALUES (?, ?, ?, ?, ?)',
      [req.user.restaurantId, name.trim(), description || null, availableFrom || null, availableTo || null]
    );
    return success(res, { id: result.insertId }, 'Category created.', HTTP_STATUS.CREATED);
  } catch (err) {
    console.error('[Menu] createCategory error:', err);
    return error(res, 'Failed to create category.');
  }
}

async function updateCategory(req, res) {
  try {
    const { categoryId } = req.params;
    const { name, description, isActive, availableFrom, availableTo } = req.body;
    await query(
      `UPDATE menu_categories SET 
        name = COALESCE(?, name), 
        description = COALESCE(?, description), 
        is_active = COALESCE(?, is_active),
        available_from = ?,
        available_to = ?
       WHERE id = ? AND restaurant_id = ?`,
      [name || null, description || null, isActive !== undefined ? (isActive ? 1 : 0) : null, availableFrom || null, availableTo || null, categoryId, req.user.restaurantId]
    );
    return success(res, null, 'Category updated.');
  } catch (err) {
    console.error('[Menu] updateCategory error:', err);
    return error(res, 'Failed to update category.');
  }
}

async function deleteCategory(req, res) {
  try {
    const { categoryId } = req.params;
    const [items] = await query('SELECT COUNT(*) AS count FROM menu_items WHERE category_id = ? AND restaurant_id = ?', [categoryId, req.user.restaurantId]);
    if (items[0].count > 0) return error(res, 'Cannot delete category with menu items. Move or delete items first.', HTTP_STATUS.BAD_REQUEST);
    await query('DELETE FROM menu_categories WHERE id = ? AND restaurant_id = ?', [categoryId, req.user.restaurantId]);
    return success(res, null, 'Category deleted.');
  } catch (err) {
    console.error('[Menu] deleteCategory error:', err);
    return error(res, 'Failed to delete category.');
  }
}

async function reorderCategories(req, res) {
  const { order } = req.body; // [{id, sortOrder}]
  if (!Array.isArray(order)) return error(res, 'order must be an array.', HTTP_STATUS.BAD_REQUEST);
  for (const item of order) {
    await query('UPDATE menu_categories SET sort_order = ? WHERE id = ? AND restaurant_id = ?', [item.sortOrder, item.id, req.user.restaurantId]);
  }
  return success(res, null, 'Categories reordered.');
}

// MENU ITEMS
async function getMenuItems(req, res) {
  try {
    let rId = req.user?.restaurantId;
    if (!rId && req.query.restaurantSlug) {
      const [r] = await query('SELECT id, name FROM restaurants WHERE slug = ? AND is_active = 1 LIMIT 1', [req.query.restaurantSlug]);
      rId = r?.[0]?.id;
    }
    if (!rId && req.query.restaurantId) rId = req.query.restaurantId;
    if (!rId) return success(res, []);
    const { categoryId, search, available } = req.query;

    let where = 'WHERE mi.restaurant_id = ?';
    const params = [rId];

    if (categoryId) { where += ' AND mi.category_id = ?'; params.push(categoryId); }
    if (search) { where += ' AND mi.name LIKE ?'; params.push(`%${search}%`); }
    if (available === 'true') {
      where += ' AND mi.is_available = 1';
      // Filter by item availability time window (NULL means always available)
      where += ' AND (mi.available_from IS NULL OR mi.available_to IS NULL OR CURTIME() BETWEEN mi.available_from AND mi.available_to)';
      // Filter by category availability time window too
      where += ' AND (c.id IS NULL OR c.available_from IS NULL OR c.available_to IS NULL OR CURTIME() BETWEEN c.available_from AND c.available_to)';
    }

    const [rows] = await query(
      `SELECT mi.*, c.name AS category_name FROM menu_items mi
       LEFT JOIN menu_categories c ON c.id = mi.category_id
       ${where} ORDER BY mi.is_featured DESC, mi.sort_order ASC, mi.name ASC`,
      params
    );

    // Fetch variants and addons for all items
    if (rows && rows.length > 0) {
      const itemIds = rows.map(r => r.id);
      const placeholders = itemIds.map(() => '?').join(',');

      const [variants] = await query(`SELECT * FROM menu_item_variants WHERE menu_item_id IN (${placeholders})`, itemIds);
      const [addons] = await query(`SELECT * FROM menu_item_addons WHERE menu_item_id IN (${placeholders})`, itemIds);

      rows.forEach(r => {
        r.variants = variants.filter(v => v.menu_item_id === r.id);
        r.addons = addons.filter(a => a.menu_item_id === r.id);
      });
    }

    return success(res, rows);
  } catch (err) {
    console.error('[Menu] getMenuItems error:', err);
    return error(res, 'Internal server error while fetching menu items.', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
}

async function getMenuItemById(req, res) {
  const { itemId } = req.params;
  const [rows] = await query('SELECT * FROM menu_items WHERE id = ? AND restaurant_id = ? LIMIT 1', [itemId, req.user.restaurantId]);
  if (!rows || rows.length === 0) return error(res, 'Item not found.', HTTP_STATUS.NOT_FOUND);
  const [variants] = await query('SELECT * FROM menu_item_variants WHERE menu_item_id = ?', [itemId]);
  const [addons] = await query('SELECT * FROM menu_item_addons WHERE menu_item_id = ?', [itemId]);
  return success(res, { ...rows[0], variants, addons });
}

async function createMenuItem(req, res) {
  const rId = req.user.restaurantId;
  const { name, description, price, categoryId, itemType, imageUrl, taxRate, preparationTime, isFeatured, variants, addons } = req.body;
  if (!name || price === undefined) return error(res, 'name and price are required.', HTTP_STATUS.BAD_REQUEST);

  // Check plan limit
  const [countRows] = await query('SELECT COUNT(*) AS count FROM menu_items WHERE restaurant_id = ?', [rId]);
  const limitCheck = await checkLimit(rId, 'max_menu_items', countRows[0].count);
  if (!limitCheck.allowed) return error(res, `Menu item limit reached (${limitCheck.limit}). Upgrade your plan.`, HTTP_STATUS.FORBIDDEN, { upgradeRequired: true });

  const result = await transaction(async (conn) => {
    const hasVariants = variants && variants.length > 0;
    const [itemRes] = await conn.execute(
      'INSERT INTO menu_items (restaurant_id, category_id, name, description, price, item_type, image_url, tax_rate, preparation_time, is_featured, has_variants, available_from, available_to) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [rId, categoryId || null, name.trim(), description || null, price, itemType || 'veg', imageUrl || null, taxRate || 5, preparationTime || 15, isFeatured ? 1 : 0, hasVariants ? 1 : 0, req.body.availableFrom || null, req.body.availableTo || null]
    );
    const itemId = itemRes.insertId;

    if (hasVariants) {
      for (const v of variants) {
        await conn.execute('INSERT INTO menu_item_variants (menu_item_id, name, price) VALUES (?, ?, ?)', [itemId, v.name, v.price]);
      }
    }

    if (addons && addons.length > 0) {
      for (const a of addons) {
        await conn.execute('INSERT INTO menu_item_addons (menu_item_id, name, price) VALUES (?, ?, ?)', [itemId, a.name, a.price]);
      }
    }

    return itemId;
  });

  return success(res, { id: result }, 'Item created.', HTTP_STATUS.CREATED);
}

async function updateMenuItem(req, res) {
  const { itemId } = req.params;
  const { name, description, price, categoryId, itemType, imageUrl, taxRate, preparationTime, isFeatured, isAvailable, variants, addons } = req.body;

  await transaction(async (conn) => {
    const hasVariants = variants && variants.length > 0 ? 1 : 0;
    await conn.execute(
      `UPDATE menu_items SET name = COALESCE(?, name), description = COALESCE(?, description),
        price = ?, category_id = ?, item_type = COALESCE(?, item_type),
        image_url = ?, tax_rate = COALESCE(?, tax_rate), preparation_time = COALESCE(?, preparation_time),
        is_featured = COALESCE(?, is_featured), is_available = COALESCE(?, is_available), has_variants = ?,
        available_from = ?, available_to = ?
       WHERE id = ? AND restaurant_id = ?`,
      [
        name || null, description || null, price, categoryId || null, itemType || null,
        imageUrl || null, taxRate || null, preparationTime || null,
        isFeatured !== undefined ? (isFeatured ? 1 : 0) : null,
        isAvailable !== undefined ? (isAvailable ? 1 : 0) : null,
        hasVariants,
        req.body.availableFrom || null,
        req.body.availableTo || null,
        itemId, req.user.restaurantId
      ]
    );

    // Refresh variants
    await conn.execute('DELETE FROM menu_item_variants WHERE menu_item_id = ?', [itemId]);
    if (variants && variants.length > 0) {
      for (const v of variants) {
        await conn.execute('INSERT INTO menu_item_variants (menu_item_id, name, price) VALUES (?, ?, ?)', [itemId, v.name, v.price]);
      }
    }

    // Refresh addons
    await conn.execute('DELETE FROM menu_item_addons WHERE menu_item_id = ?', [itemId]);
    if (addons && addons.length > 0) {
      for (const a of addons) {
        await conn.execute('INSERT INTO menu_item_addons (menu_item_id, name, price) VALUES (?, ?, ?)', [itemId, a.name, a.price]);
      }
    }
  });

  return success(res, null, 'Item updated.');
}

async function toggleItemAvailability(req, res) {
  const { itemId } = req.params;
  await query(
    'UPDATE menu_items SET is_available = NOT is_available WHERE id = ? AND restaurant_id = ?',
    [itemId, req.user.restaurantId]
  );
  return success(res, null, 'Availability toggled.');
}

async function deleteMenuItem(req, res) {
  const { itemId } = req.params;
  // Use hard delete to avoid confusion, cascade handles variants/addons
  await query('DELETE FROM menu_items WHERE id = ? AND restaurant_id = ?', [itemId, req.user.restaurantId]);
  return success(res, null, 'Item deleted.');
}

// VARIANTS
async function addVariant(req, res) {
  const { itemId } = req.params;
  const { name, price } = req.body;
  if (!name || price === undefined) return error(res, 'name and price are required.', HTTP_STATUS.BAD_REQUEST);

  // Verify menu item belongs to user's restaurant
  const [itemRows] = await query('SELECT id FROM menu_items WHERE id = ? AND restaurant_id = ?', [itemId, req.user.restaurantId]);
  if (!itemRows || itemRows.length === 0) return error(res, 'Menu item not found.', HTTP_STATUS.NOT_FOUND);

  const [result] = await query('INSERT INTO menu_item_variants (menu_item_id, name, price) VALUES (?, ?, ?)', [itemId, name, price]);
  return success(res, { id: result.insertId }, 'Variant added.', HTTP_STATUS.CREATED);
}

async function updateVariant(req, res) {
  const { variantId } = req.params;
  const { name, price, isAvailable } = req.body;
  await query(
    'UPDATE menu_item_variants SET name = COALESCE(?, name), price = COALESCE(?, price), is_available = COALESCE(?, is_available) WHERE id = ? AND menu_item_id IN (SELECT id FROM menu_items WHERE restaurant_id = ?)',
    [name || null, price || null, isAvailable !== undefined ? (isAvailable ? 1 : 0) : null, variantId, req.user.restaurantId]
  );
  return success(res, null, 'Variant updated.');
}

async function deleteVariant(req, res) {
  const { variantId } = req.params;
  await query('DELETE FROM menu_item_variants WHERE id = ? AND menu_item_id IN (SELECT id FROM menu_items WHERE restaurant_id = ?)', [variantId, req.user.restaurantId]);
  return success(res, null, 'Variant deleted.');
}

module.exports = { getCategories, createCategory, updateCategory, deleteCategory, reorderCategories, getMenuItems, getMenuItemById, createMenuItem, updateMenuItem, toggleItemAvailability, deleteMenuItem, addVariant, updateVariant, deleteVariant };
