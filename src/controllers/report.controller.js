'use strict';

const { query } = require('../config/database');
const { success, error } = require('../utils/responseHelper');
const { HTTP_STATUS } = require('../config/constants');

function dateFilter(startDate, endDate, alias = 'o') {
  const params = [];
  let sql = '';
  if (startDate) { sql += ` AND DATE(${alias}.created_at) >= ?`; params.push(startDate); }
  if (endDate) { sql += ` AND DATE(${alias}.created_at) <= ?`; params.push(endDate); }
  return { sql, params };
}

/* ─── sales summary ────────────────────────────────────────────────────────── */

async function getSalesSummary(req, res) {
  const { startDate, endDate, groupBy = 'day' } = req.query;
  const df = dateFilter(startDate, endDate);

  const [totals] = await query(
    `SELECT
       COUNT(*) AS total_orders,
       SUM(o.total_amount) AS total_revenue,
       AVG(o.total_amount) AS avg_order_value,
       SUM(CASE WHEN o.order_type = 'dine_in' THEN 1 ELSE 0 END) AS dine_in_orders,
       SUM(CASE WHEN o.order_type = 'takeaway' THEN 1 ELSE 0 END) AS takeaway_orders,
       SUM(CASE WHEN o.order_type = 'delivery' THEN 1 ELSE 0 END) AS delivery_orders
     FROM orders o
     WHERE o.restaurant_id = ? AND o.payment_status = 'paid' ${df.sql}`,
    [req.user.restaurantId, ...df.params]
  );

  // Daily/weekly/monthly breakdown
  let groupExpr = "DATE(o.created_at)";
  if (groupBy === 'week') groupExpr = "YEARWEEK(o.created_at, 1)";
  if (groupBy === 'month') groupExpr = "DATE_FORMAT(o.created_at, '%Y-%m')";

  const [chart] = await query(
    `SELECT
       ${groupExpr} AS period,
       COUNT(*) AS orders,
       SUM(total_amount) AS revenue
     FROM orders o
     WHERE restaurant_id = ? AND payment_status = 'paid' ${df.sql}
     GROUP BY period
     ORDER BY period ASC`,
    [req.user.restaurantId, ...df.params]
  );

  return success(res, { summary: totals[0], chart });
}

/* ─── item-wise sales ──────────────────────────────────────────────────────── */

async function getItemWiseReport(req, res) {
  const { startDate, endDate, categoryId, limit = 20 } = req.query;
  const df = dateFilter(startDate, endDate);
  const params = [req.user.restaurantId, ...df.params];
  let catFilter = '';
  if (categoryId) { catFilter = ' AND mi.category_id = ?'; params.push(categoryId); }

  const [rows] = await query(
    `SELECT
       oi.menu_item_id, oi.item_name,
       mi.category_id, mc.name AS category_name,
       SUM(oi.quantity) AS total_qty,
       SUM(oi.total_price) AS total_revenue,
       COUNT(DISTINCT oi.order_id) AS order_count
     FROM order_items oi
     JOIN orders o ON o.id = oi.order_id
     LEFT JOIN menu_items mi ON mi.id = oi.menu_item_id
     LEFT JOIN menu_categories mc ON mc.id = mi.category_id
     WHERE o.restaurant_id = ? AND o.payment_status = 'paid'
       AND oi.status != 'cancelled' ${df.sql} ${catFilter}
     GROUP BY oi.menu_item_id, oi.item_name
     ORDER BY total_qty DESC
     LIMIT ${parseInt(limit)}`,
    params
  );
  return success(res, rows);
}

/* ─── category-wise ────────────────────────────────────────────────────────── */

async function getCategoryWiseReport(req, res) {
  const { startDate, endDate } = req.query;
  const df = dateFilter(startDate, endDate);

  const [rows] = await query(
    `SELECT
       mc.id AS category_id, mc.name AS category_name,
       SUM(oi.quantity) AS total_qty,
       SUM(oi.total_price) AS total_revenue
     FROM order_items oi
     JOIN orders o ON o.id = oi.order_id
     LEFT JOIN menu_items mi ON mi.id = oi.menu_item_id
     LEFT JOIN menu_categories mc ON mc.id = mi.category_id
     WHERE o.restaurant_id = ? AND o.payment_status = 'paid' AND oi.status != 'cancelled' ${df.sql}
     GROUP BY mc.id
     ORDER BY total_revenue DESC`,
    [req.user.restaurantId, ...df.params]
  );
  return success(res, rows);
}

/* ─── payment mode report ──────────────────────────────────────────────────── */

async function getPaymentModeReport(req, res) {
  const { startDate, endDate } = req.query;
  const df = dateFilter(startDate, endDate);

  const [rows] = await query(
    `SELECT
       o.payment_mode,
       COUNT(*) AS transaction_count,
       SUM(o.total_amount) AS total_amount
     FROM orders o
     WHERE o.restaurant_id = ? AND o.payment_status = 'paid' ${df.sql}
     GROUP BY o.payment_mode
     ORDER BY total_amount DESC`,
    [req.user.restaurantId, ...df.params]
  );
  return success(res, rows);
}

/* ─── waiter performance ───────────────────────────────────────────────────── */

async function getWaiterReport(req, res) {
  const { startDate, endDate } = req.query;
  const df = dateFilter(startDate, endDate);

  const [rows] = await query(
    `SELECT
       u.id AS waiter_id, u.name AS waiter_name,
       COUNT(o.id) AS orders_handled,
       SUM(o.total_amount) AS total_sales,
       AVG(o.total_amount) AS avg_order_value
     FROM orders o
     JOIN users u ON u.id = o.waiter_id
     WHERE o.restaurant_id = ? AND o.payment_status = 'paid' ${df.sql}
     GROUP BY u.id
     ORDER BY total_sales DESC`,
    [req.user.restaurantId, ...df.params]
  );
  return success(res, rows);
}

/* ─── tax report ───────────────────────────────────────────────────────────── */

async function getTaxReport(req, res) {
  const { startDate, endDate } = req.query;
  const df = dateFilter(startDate, endDate);

  const [rows] = await query(
    `SELECT
       oi.tax_rate,
       SUM(oi.total_price - oi.tax_amount) AS taxable_amount,
       SUM(oi.tax_amount) AS tax_collected,
       SUM(oi.total_price) AS gross_amount,
       COUNT(*) AS item_count
     FROM order_items oi
     JOIN orders o ON o.id = oi.order_id
     WHERE o.restaurant_id = ? AND o.payment_status = 'paid' AND oi.status != 'cancelled' ${df.sql}
     GROUP BY oi.tax_rate
     ORDER BY oi.tax_rate ASC`,
    [req.user.restaurantId, ...df.params]
  );

  const [totals] = await query(
    `SELECT
       SUM(oi.total_price - oi.tax_amount) AS total_taxable,
       SUM(oi.tax_amount) AS total_tax,
       SUM(oi.total_price) AS total_gross
     FROM order_items oi
     JOIN orders o ON o.id = oi.order_id
     WHERE o.restaurant_id = ? AND o.payment_status = 'paid' AND oi.status != 'cancelled' ${df.sql}`,
    [req.user.restaurantId, ...df.params]
  );

  return success(res, { breakdown: rows, totals: totals[0] });
}

/* ─── hourly heatmap ───────────────────────────────────────────────────────── */

async function getHourlyReport(req, res) {
  const { startDate, endDate } = req.query;
  const df = dateFilter(startDate, endDate);

  const [rows] = await query(
    `SELECT
       HOUR(o.created_at) AS hour,
       DAYOFWEEK(o.created_at) AS day_of_week,
       COUNT(*) AS orders,
       SUM(o.total_amount) AS revenue
     FROM orders o
     WHERE o.restaurant_id = ? AND o.payment_status = 'paid' ${df.sql}
     GROUP BY hour, day_of_week
     ORDER BY day_of_week, hour`,
    [req.user.restaurantId, ...df.params]
  );
  return success(res, rows);
}

/* ─── expense report ───────────────────────────────────────────────────────── */

async function getExpenseReport(req, res) {
  const { startDate, endDate } = req.query;
  let where = "WHERE e.restaurant_id = ? AND e.status = 'approved'";
  const params = [req.user.restaurantId];
  if (startDate) { where += ' AND DATE(e.expense_date) >= ?'; params.push(startDate); }
  if (endDate) { where += ' AND DATE(e.expense_date) <= ?'; params.push(endDate); }

  const [rows] = await query(
    `SELECT ec.name AS category, SUM(e.amount) AS total, COUNT(*) AS count
     FROM expenses e
     LEFT JOIN expense_categories ec ON ec.id = e.category_id
     ${where}
     GROUP BY e.category_id
     ORDER BY total DESC`,
    params
  );

  const [totals] = await query(`SELECT SUM(amount) AS total FROM expenses e ${where}`, params);

  return success(res, { byCategory: rows, total: totals[0].total });
}

module.exports = {
  getSalesSummary, getItemWiseReport, getCategoryWiseReport,
  getPaymentModeReport, getWaiterReport, getTaxReport,
  getHourlyReport, getExpenseReport,
};
