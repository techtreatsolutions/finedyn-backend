'use strict';

const { query, transaction } = require('../config/database');
const { success, error } = require('../utils/responseHelper');
const { HTTP_STATUS } = require('../config/constants');
const { sanitizePagination } = require('../utils/validate');

/* ─── categories ───────────────────────────────────────────────────────────── */

async function getCategories(req, res) {
  const [rows] = await query(
    'SELECT * FROM expense_categories WHERE restaurant_id = ? ORDER BY name ASC',
    [req.user.restaurantId]
  );
  return success(res, rows);
}

async function createCategory(req, res) {
  const { name } = req.body;
  if (!name) return error(res, 'name is required.', HTTP_STATUS.BAD_REQUEST);
  const [result] = await query(
    'INSERT INTO expense_categories (restaurant_id, name) VALUES (?, ?)',
    [req.user.restaurantId, name]
  );
  return success(res, { id: result.insertId }, 'Category created.', HTTP_STATUS.CREATED);
}

async function deleteCategory(req, res) {
  const { categoryId } = req.params;
  const [expenses] = await query(
    'SELECT COUNT(*) AS cnt FROM expenses WHERE category_id = ? AND restaurant_id = ?',
    [categoryId, req.user.restaurantId]
  );
  if (expenses[0].cnt > 0) return error(res, 'Cannot delete category with existing expenses.', HTTP_STATUS.CONFLICT);
  await query('DELETE FROM expense_categories WHERE id = ? AND restaurant_id = ?', [categoryId, req.user.restaurantId]);
  return success(res, null, 'Category deleted.');
}

/* ─── expenses ─────────────────────────────────────────────────────────────── */

async function getExpenses(req, res) {
  const { categoryId, status, startDate, endDate } = req.query;
  const { page: parsedPage, limit: parsedLimit } = sanitizePagination(req.query);
  const offset = (parsedPage - 1) * parsedLimit;

  let where = 'WHERE e.restaurant_id = ?';
  const params = [req.user.restaurantId];
  if (categoryId) { where += ' AND e.category_id = ?'; params.push(categoryId); }
  if (status) { where += ' AND e.status = ?'; params.push(status); }
  if (startDate) { where += ' AND DATE(e.expense_date) >= ?'; params.push(startDate); }
  if (endDate) { where += ' AND DATE(e.expense_date) <= ?'; params.push(endDate); }

  const [countRows] = await query(`SELECT COUNT(*) AS total FROM expenses e ${where}`, params);
  const [rows] = await query(
    `SELECT e.*, ec.name AS category_name, u.name AS created_by_name, a.name AS approved_by_name
     FROM expenses e
     LEFT JOIN expense_categories ec ON ec.id = e.category_id
     LEFT JOIN users u ON u.id = e.created_by
     LEFT JOIN users a ON a.id = e.approved_by
     ${where}
     ORDER BY e.expense_date DESC
     LIMIT ? OFFSET ?`,
    [...params, parsedLimit, offset]
  );

  return success(res, { expenses: rows, total: countRows[0].total, page: parsedPage });
}

async function getExpenseById(req, res) {
  const { expenseId } = req.params;
  const [rows] = await query(
    `SELECT e.*, ec.name AS category_name, u.name AS created_by_name
     FROM expenses e
     LEFT JOIN expense_categories ec ON ec.id = e.category_id
     LEFT JOIN users u ON u.id = e.created_by
     WHERE e.id = ? AND e.restaurant_id = ? LIMIT 1`,
    [expenseId, req.user.restaurantId]
  );
  if (!rows || rows.length === 0) return error(res, 'Expense not found.', HTTP_STATUS.NOT_FOUND);
  return success(res, rows[0]);
}

async function createExpense(req, res) {
  const { categoryId, title, amount, paymentMode, expenseDate, notes, receiptUrl } = req.body;
  if (!title || !amount) return error(res, 'title and amount are required.', HTTP_STATUS.BAD_REQUEST);

  const [result] = await query(
    `INSERT INTO expenses (restaurant_id, category_id, title, amount, payment_mode, expense_date, notes, receipt_url, created_by, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
    [
      req.user.restaurantId, categoryId || null, title, amount,
      paymentMode || 'cash', expenseDate || (() => { const n = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' })); return `${n.getFullYear()}-${String(n.getMonth()+1).padStart(2,'0')}-${String(n.getDate()).padStart(2,'0')}`; })(),
      notes || null, receiptUrl || null, req.user.id
    ]
  );
  return success(res, { id: result.insertId }, 'Expense recorded.', HTTP_STATUS.CREATED);
}

async function updateExpense(req, res) {
  const { expenseId } = req.params;
  const { categoryId, title, amount, paymentMode, expenseDate, notes, receiptUrl } = req.body;

  const [rows] = await query(
    'SELECT status FROM expenses WHERE id = ? AND restaurant_id = ? LIMIT 1',
    [expenseId, req.user.restaurantId]
  );
  if (!rows || rows.length === 0) return error(res, 'Expense not found.', HTTP_STATUS.NOT_FOUND);
  if (rows[0].status === 'approved') return error(res, 'Cannot edit an approved expense.', HTTP_STATUS.BAD_REQUEST);

  await query(
    `UPDATE expenses SET
       category_id = COALESCE(?, category_id),
       title = COALESCE(?, title),
       amount = COALESCE(?, amount),
       payment_mode = COALESCE(?, payment_mode),
       expense_date = COALESCE(?, expense_date),
       notes = COALESCE(?, notes),
       receipt_url = COALESCE(?, receipt_url)
     WHERE id = ? AND restaurant_id = ?`,
    [categoryId || null, title || null, amount || null, paymentMode || null, expenseDate || null, notes || null, receiptUrl || null, expenseId, req.user.restaurantId]
  );
  return success(res, null, 'Expense updated.');
}

async function approveExpense(req, res) {
  const { expenseId } = req.params;
  const { status, notes } = req.body;
  const validStatuses = ['approved', 'rejected'];
  if (!validStatuses.includes(status)) return error(res, 'Invalid status. Use approved or rejected.', HTTP_STATUS.BAD_REQUEST);

  const [rows] = await query(
    'SELECT * FROM expenses WHERE id = ? AND restaurant_id = ? LIMIT 1',
    [expenseId, req.user.restaurantId]
  );
  if (!rows || rows.length === 0) return error(res, 'Expense not found.', HTTP_STATUS.NOT_FOUND);
  if (rows[0].status !== 'pending') return error(res, 'Only pending expenses can be approved/rejected.', HTTP_STATUS.BAD_REQUEST);

  await query(
    'UPDATE expenses SET status = ?, approved_by = ?, approved_notes = ? WHERE id = ?',
    [status, req.user.id, notes || null, expenseId]
  );
  return success(res, null, `Expense ${status}.`);
}

async function deleteExpense(req, res) {
  const { expenseId } = req.params;
  const [rows] = await query(
    'SELECT status FROM expenses WHERE id = ? AND restaurant_id = ? LIMIT 1',
    [expenseId, req.user.restaurantId]
  );
  if (!rows || rows.length === 0) return error(res, 'Expense not found.', HTTP_STATUS.NOT_FOUND);
  if (rows[0].status === 'approved') return error(res, 'Cannot delete an approved expense.', HTTP_STATUS.BAD_REQUEST);
  await query('DELETE FROM expenses WHERE id = ? AND restaurant_id = ?', [expenseId, req.user.restaurantId]);
  return success(res, null, 'Expense deleted.');
}

async function getExpenseSummary(req, res) {
  const { startDate, endDate } = req.query;
  const params = [req.user.restaurantId];
  let dateFilter = '';
  if (startDate) { dateFilter += ' AND DATE(e.expense_date) >= ?'; params.push(startDate); }
  if (endDate) { dateFilter += ' AND DATE(e.expense_date) <= ?'; params.push(endDate); }

  const [summary] = await query(
    `SELECT
       SUM(CASE WHEN status = 'approved' THEN amount ELSE 0 END) AS approved_total,
       SUM(CASE WHEN status = 'pending' THEN amount ELSE 0 END) AS pending_total,
       COUNT(*) AS total_count
     FROM expenses e
     WHERE restaurant_id = ? ${dateFilter}`,
    params
  );

  const [byCategory] = await query(
    `SELECT ec.name AS category, SUM(e.amount) AS total
     FROM expenses e
     LEFT JOIN expense_categories ec ON ec.id = e.category_id
     WHERE e.restaurant_id = ? AND e.status = 'approved' ${dateFilter}
     GROUP BY e.category_id
     ORDER BY total DESC`,
    params
  );

  return success(res, { summary: summary[0], byCategory });
}

module.exports = {
  getCategories, createCategory, deleteCategory,
  getExpenses, getExpenseById, createExpense, updateExpense, approveExpense, deleteExpense,
  getExpenseSummary,
};
