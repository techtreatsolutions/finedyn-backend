'use strict';

const ExcelJS = require('exceljs');
const { query } = require('../config/database');
const { error } = require('../utils/responseHelper');
const { HTTP_STATUS } = require('../config/constants');

/* ── helpers ──────────────────────────────────────────────────────────────── */

function dateFilter(startDate, endDate, alias, col = 'created_at') {
  const params = [];
  let sql = '';
  if (startDate) { sql += ` AND DATE(${alias}.${col}) >= ?`; params.push(startDate); }
  if (endDate) { sql += ` AND DATE(${alias}.${col}) <= ?`; params.push(endDate); }
  return { sql, params };
}

function styleHeader(sheet) {
  const headerRow = sheet.getRow(1);
  headerRow.font = { bold: true, size: 11, color: { argb: 'FFFFFFFF' } };
  headerRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0F172A' } };
  headerRow.alignment = { vertical: 'middle', horizontal: 'center' };
  headerRow.height = 28;
  sheet.columns.forEach(col => {
    col.width = Math.max(col.width || 12, 14);
  });
}

function sendWorkbook(res, workbook, filename) {
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  return workbook.xlsx.write(res).then(() => res.end());
}

function fmtDate(d) {
  if (!d) return '';
  const dt = new Date(d);
  return isNaN(dt) ? '' : dt.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
}

function fmtDateTime(d) {
  if (!d) return '';
  const dt = new Date(d);
  return isNaN(dt) ? '' : dt.toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true });
}

function num(v) { return parseFloat(v) || 0; }

/* ═══════════════════════════════════════════════════════════════════════════
   1. CUSTOMERS REPORT
   ═══════════════════════════════════════════════════════════════════════════ */

async function exportCustomers(req, res) {
  const { startDate, endDate } = req.query;
  const rId = req.user.restaurantId;
  const df = dateFilter(startDate, endDate, 'o');

  const [rows] = await query(
    `SELECT
       o.customer_name, o.customer_phone,
       COUNT(DISTINCT o.id) AS total_orders,
       SUM(o.total_amount) AS total_spent,
       AVG(o.total_amount) AS avg_order_value,
       MIN(o.created_at) AS first_order,
       MAX(o.created_at) AS last_order,
       SUM(o.tax_amount) AS total_tax_paid,
       GROUP_CONCAT(DISTINCT o.order_type) AS order_types,
       GROUP_CONCAT(DISTINCT o.payment_mode) AS payment_modes
     FROM orders o
     WHERE o.restaurant_id = ? AND o.customer_phone IS NOT NULL AND o.customer_phone != ''
       AND o.payment_status = 'paid' ${df.sql}
     GROUP BY o.customer_phone
     ORDER BY total_spent DESC`,
    [rId, ...df.params]
  );

  const wb = new ExcelJS.Workbook();
  wb.creator = 'DineSys';
  const ws = wb.addWorksheet('Customers');

  ws.columns = [
    { header: 'Customer Name', key: 'name', width: 22 },
    { header: 'Phone', key: 'phone', width: 16 },
    { header: 'Total Orders', key: 'orders', width: 14 },
    { header: 'Total Spent (₹)', key: 'spent', width: 16 },
    { header: 'Avg Order Value (₹)', key: 'avg', width: 18 },
    { header: 'Total Tax Paid (₹)', key: 'tax', width: 16 },
    { header: 'First Order', key: 'first', width: 18 },
    { header: 'Last Order', key: 'last', width: 18 },
    { header: 'Order Types', key: 'types', width: 22 },
    { header: 'Payment Modes', key: 'modes', width: 22 },
  ];

  for (const r of rows) {
    ws.addRow({
      name: r.customer_name || 'Guest',
      phone: r.customer_phone,
      orders: r.total_orders,
      spent: num(r.total_spent).toFixed(2),
      avg: num(r.avg_order_value).toFixed(2),
      tax: num(r.total_tax_paid).toFixed(2),
      first: fmtDate(r.first_order),
      last: fmtDate(r.last_order),
      types: r.order_types || '',
      modes: r.payment_modes || '',
    });
  }

  styleHeader(ws);
  return sendWorkbook(res, wb, `Customers_Report_${startDate || 'all'}_to_${endDate || 'all'}.xlsx`);
}

/* ═══════════════════════════════════════════════════════════════════════════
   2. ORDERS REPORT (with CGST / SGST)
   ═══════════════════════════════════════════════════════════════════════════ */

async function exportOrders(req, res) {
  const { startDate, endDate } = req.query;
  const rId = req.user.restaurantId;
  const df = dateFilter(startDate, endDate, 'o');

  const [orders] = await query(
    `SELECT o.*,
            t.table_number, COALESCE(f1.name, f2.name) AS floor_name,
            w.name AS waiter_name, c.name AS cashier_name
     FROM orders o
     LEFT JOIN tables t ON t.id = o.table_id
     LEFT JOIN floors f1 ON f1.id = o.floor_id
     LEFT JOIN floors f2 ON f2.id = t.floor_id
     LEFT JOIN users w ON w.id = o.waiter_id
     LEFT JOIN users c ON c.id = o.cashier_id
     WHERE o.restaurant_id = ? ${df.sql}
     ORDER BY o.created_at DESC`,
    [rId, ...df.params]
  );

  // Fetch all order items for these orders
  const orderIds = orders.map(o => o.id);
  let itemsMap = {};
  if (orderIds.length > 0) {
    const [items] = await query(
      `SELECT oi.* FROM order_items oi WHERE oi.order_id IN (${orderIds.map(() => '?').join(',')}) ORDER BY oi.order_id, oi.created_at`,
      orderIds
    );
    for (const item of items) {
      if (!itemsMap[item.order_id]) itemsMap[item.order_id] = [];
      itemsMap[item.order_id].push(item);
    }
  }

  const wb = new ExcelJS.Workbook();
  wb.creator = 'DineSys';

  // ── Sheet 1: Orders Summary ──
  const ws1 = wb.addWorksheet('Orders');
  ws1.columns = [
    { header: 'Order #', key: 'orderNumber', width: 16 },
    { header: 'Date & Time', key: 'dateTime', width: 20 },
    { header: 'Order Type', key: 'orderType', width: 14 },
    { header: 'Status', key: 'status', width: 14 },
    { header: 'Customer Name', key: 'customerName', width: 20 },
    { header: 'Customer Phone', key: 'customerPhone', width: 16 },
    { header: 'Table', key: 'table', width: 10 },
    { header: 'Floor', key: 'floor', width: 14 },
    { header: 'Waiter', key: 'waiter', width: 16 },
    { header: 'Cashier', key: 'cashier', width: 16 },
    { header: 'Subtotal (₹)', key: 'subtotal', width: 14 },
    { header: 'CGST (₹)', key: 'cgst', width: 12 },
    { header: 'SGST (₹)', key: 'sgst', width: 12 },
    { header: 'Total Tax (₹)', key: 'totalTax', width: 14 },
    { header: 'Discount (₹)', key: 'discount', width: 14 },
    { header: 'Total Amount (₹)', key: 'totalAmount', width: 16 },
    { header: 'Payment Status', key: 'paymentStatus', width: 16 },
    { header: 'Payment Mode', key: 'paymentMode', width: 16 },
    { header: 'Bill Number', key: 'billNumber', width: 14 },
    { header: 'Completed At', key: 'completedAt', width: 20 },
    { header: 'Notes', key: 'notes', width: 24 },
  ];

  for (const o of orders) {
    const tax = num(o.tax_amount);
    const cgst = num((tax / 2).toFixed(2));
    const sgst = num((tax / 2).toFixed(2));
    ws1.addRow({
      orderNumber: o.order_number,
      dateTime: fmtDateTime(o.created_at),
      orderType: o.order_type?.replace('_', ' '),
      status: o.status,
      customerName: o.customer_name || '',
      customerPhone: o.customer_phone || '',
      table: o.table_number || '',
      floor: o.floor_name || '',
      waiter: o.waiter_name || '',
      cashier: o.cashier_name || '',
      subtotal: num(o.subtotal).toFixed(2),
      cgst: cgst.toFixed(2),
      sgst: sgst.toFixed(2),
      totalTax: tax.toFixed(2),
      discount: num(o.discount_amount).toFixed(2),
      totalAmount: num(o.total_amount).toFixed(2),
      paymentStatus: o.payment_status,
      paymentMode: o.payment_mode || '',
      billNumber: o.bill_number || '',
      completedAt: fmtDateTime(o.completed_at),
      notes: o.notes || '',
    });
  }
  styleHeader(ws1);

  // ── Sheet 2: Order Items Detail ──
  const ws2 = wb.addWorksheet('Order Items');
  ws2.columns = [
    { header: 'Order #', key: 'orderNumber', width: 16 },
    { header: 'Order Date', key: 'orderDate', width: 18 },
    { header: 'Item Name', key: 'itemName', width: 24 },
    { header: 'Variant', key: 'variant', width: 16 },
    { header: 'Add-ons', key: 'addons', width: 24 },
    { header: 'Quantity', key: 'qty', width: 10 },
    { header: 'Unit Price (₹)', key: 'unitPrice', width: 14 },
    { header: 'Total Price (₹)', key: 'totalPrice', width: 14 },
    { header: 'Tax Rate (%)', key: 'taxRate', width: 12 },
    { header: 'Tax Amount (₹)', key: 'taxAmount', width: 14 },
    { header: 'CGST (₹)', key: 'cgst', width: 12 },
    { header: 'SGST (₹)', key: 'sgst', width: 12 },
    { header: 'Item Status', key: 'itemStatus', width: 14 },
    { header: 'Notes', key: 'notes', width: 20 },
  ];

  for (const o of orders) {
    const oItems = itemsMap[o.id] || [];
    for (const item of oItems) {
      const itemTax = num(item.tax_amount);
      let addonsStr = '';
      if (item.addon_details) {
        try {
          const addons = typeof item.addon_details === 'string' ? JSON.parse(item.addon_details) : item.addon_details;
          addonsStr = (addons || []).map(a => a.name).join(', ');
        } catch { }
      }
      ws2.addRow({
        orderNumber: o.order_number,
        orderDate: fmtDateTime(o.created_at),
        itemName: item.item_name,
        variant: item.variant_id ? `Variant #${item.variant_id}` : '',
        addons: addonsStr,
        qty: item.quantity,
        unitPrice: num(item.item_price).toFixed(2),
        totalPrice: num(item.total_price).toFixed(2),
        taxRate: num(item.tax_rate),
        taxAmount: itemTax.toFixed(2),
        cgst: (itemTax / 2).toFixed(2),
        sgst: (itemTax / 2).toFixed(2),
        itemStatus: item.status,
        notes: item.notes || '',
      });
    }
  }
  styleHeader(ws2);

  return sendWorkbook(res, wb, `Orders_Report_${startDate || 'all'}_to_${endDate || 'all'}.xlsx`);
}

/* ═══════════════════════════════════════════════════════════════════════════
   3. EMPLOYEES REPORT
   ═══════════════════════════════════════════════════════════════════════════ */

async function exportEmployees(req, res) {
  const rId = req.user.restaurantId;

  const [employees] = await query(
    `SELECT e.*,
            (SELECT COUNT(*) FROM attendance_records a WHERE a.employee_id = e.id AND a.status = 'present') AS present_days,
            (SELECT COUNT(*) FROM attendance_records a WHERE a.employee_id = e.id AND a.status = 'absent') AS absent_days,
            (SELECT COUNT(*) FROM attendance_records a WHERE a.employee_id = e.id AND a.status = 'half_day') AS half_days,
            (SELECT COUNT(*) FROM attendance_records a WHERE a.employee_id = e.id AND a.status = 'leave') AS leave_days,
            (SELECT COALESCE(SUM(amount), 0) FROM employee_advances WHERE employee_id = e.id AND type = 'advance' AND status = 'pending') AS pending_advances,
            (SELECT COALESCE(SUM(amount), 0) FROM employee_advances WHERE employee_id = e.id AND type = 'outstanding' AND status = 'pending') AS pending_outstanding
     FROM employees e
     WHERE e.restaurant_id = ?
     ORDER BY e.is_active DESC, e.name ASC`,
    [rId]
  );

  const wb = new ExcelJS.Workbook();
  wb.creator = 'DineSys';
  const ws = wb.addWorksheet('Employees');

  ws.columns = [
    { header: 'Employee ID', key: 'id', width: 12 },
    { header: 'Name', key: 'name', width: 22 },
    { header: 'Phone', key: 'phone', width: 16 },
    { header: 'Email', key: 'email', width: 24 },
    { header: 'Department', key: 'department', width: 16 },
    { header: 'Designation', key: 'designation', width: 18 },
    { header: 'Base Salary (₹)', key: 'baseSalary', width: 16 },
    { header: 'Joining Date', key: 'joiningDate', width: 16 },
    { header: 'Status', key: 'status', width: 12 },
    { header: 'Bank Account', key: 'bankAccount', width: 20 },
    { header: 'Bank IFSC', key: 'bankIfsc', width: 16 },
    { header: 'Address', key: 'address', width: 28 },
    { header: 'Emergency Contact', key: 'emergency', width: 18 },
    { header: 'Present Days', key: 'present', width: 14 },
    { header: 'Absent Days', key: 'absent', width: 14 },
    { header: 'Half Days', key: 'halfDays', width: 12 },
    { header: 'Leave Days', key: 'leaveDays', width: 12 },
    { header: 'Pending Advances (₹)', key: 'advances', width: 20 },
    { header: 'Pending Outstanding (₹)', key: 'outstanding', width: 22 },
  ];

  for (const e of employees) {
    ws.addRow({
      id: e.id,
      name: e.name,
      phone: e.phone || '',
      email: e.email || '',
      department: e.department || '',
      designation: e.designation || '',
      baseSalary: num(e.base_salary || e.salary_amount).toFixed(2),
      joiningDate: fmtDate(e.joining_date),
      status: e.is_active ? 'Active' : 'Inactive',
      bankAccount: e.bank_account || '',
      bankIfsc: e.bank_ifsc || '',
      address: e.address || '',
      emergency: e.emergency_contact || '',
      present: e.present_days || 0,
      absent: e.absent_days || 0,
      halfDays: e.half_days || 0,
      leaveDays: e.leave_days || 0,
      advances: num(e.pending_advances).toFixed(2),
      outstanding: num(e.pending_outstanding).toFixed(2),
    });
  }

  styleHeader(ws);
  return sendWorkbook(res, wb, 'Employees_Report.xlsx');
}

/* ═══════════════════════════════════════════════════════════════════════════
   4. SALARIES REPORT
   ═══════════════════════════════════════════════════════════════════════════ */

async function exportSalaries(req, res) {
  const { startDate, endDate, month, year } = req.query;
  const rId = req.user.restaurantId;

  let where = 'WHERE sr.restaurant_id = ?';
  const params = [rId];

  if (month) { where += ' AND sr.month = ?'; params.push(month); }
  if (year) { where += ' AND sr.year = ?'; params.push(year); }
  if (startDate) { where += ' AND DATE(sr.created_at) >= ?'; params.push(startDate); }
  if (endDate) { where += ' AND DATE(sr.created_at) <= ?'; params.push(endDate); }

  const [rows] = await query(
    `SELECT sr.*, e.name AS employee_name, e.phone AS employee_phone,
            e.department, e.designation, e.bank_account, e.bank_ifsc,
            p.name AS paid_by_name,
            COALESCE((SELECT SUM(remaining) FROM employee_advances WHERE employee_id = sr.employee_id AND restaurant_id = sr.restaurant_id AND type = 'advance' AND status = 'pending'), 0) AS pending_advances,
            COALESCE((SELECT SUM(remaining) FROM employee_advances WHERE employee_id = sr.employee_id AND restaurant_id = sr.restaurant_id AND type = 'outstanding' AND status = 'pending'), 0) AS pending_outstanding
     FROM salary_records sr
     LEFT JOIN employees e ON e.id = sr.employee_id
     LEFT JOIN users p ON p.id = sr.paid_by
     ${where}
     ORDER BY sr.year DESC, sr.month DESC, e.name ASC`,
    params
  );

  const wb = new ExcelJS.Workbook();
  wb.creator = 'DineSys';
  const ws = wb.addWorksheet('Salaries');

  ws.columns = [
    { header: 'Salary ID', key: 'id', width: 10 },
    { header: 'Employee Name', key: 'name', width: 22 },
    { header: 'Phone', key: 'phone', width: 16 },
    { header: 'Department', key: 'department', width: 16 },
    { header: 'Designation', key: 'designation', width: 18 },
    { header: 'Month', key: 'month', width: 8 },
    { header: 'Year', key: 'year', width: 8 },
    { header: 'Basic Salary (₹)', key: 'basic', width: 16 },
    { header: 'Bonuses (₹)', key: 'bonuses', width: 14 },
    { header: 'Deductions (₹)', key: 'deductions', width: 14 },
    { header: 'Adjusted Advances (₹)', key: 'adjAdvances', width: 20 },
    { header: 'Adjusted Outstanding (₹)', key: 'adjOutstanding', width: 22 },
    { header: 'Pending Advances (₹)', key: 'pendingAdvances', width: 20 },
    { header: 'Pending Outstanding (₹)', key: 'pendingOutstanding', width: 22 },
    { header: 'Net Salary (₹)', key: 'net', width: 16 },
    { header: 'Payment Status', key: 'paymentStatus', width: 16 },
    { header: 'Payment Mode', key: 'paymentMode', width: 16 },
    { header: 'Payment Date', key: 'paymentDate', width: 16 },
    { header: 'Bank Account', key: 'bankAccount', width: 20 },
    { header: 'Bank IFSC', key: 'bankIfsc', width: 16 },
    { header: 'Paid By', key: 'paidBy', width: 16 },
    { header: 'Notes', key: 'notes', width: 24 },
    { header: 'Created At', key: 'createdAt', width: 18 },
  ];

  for (const r of rows) {
    ws.addRow({
      id: r.id,
      name: r.employee_name || '',
      phone: r.employee_phone || '',
      department: r.department || '',
      designation: r.designation || '',
      month: r.month,
      year: r.year,
      basic: num(r.basic_salary || r.base_salary).toFixed(2),
      bonuses: num(r.bonuses).toFixed(2),
      deductions: num(r.deductions).toFixed(2),
      adjAdvances: num(r.adjusted_advances || r.advances).toFixed(2),
      adjOutstanding: num(r.adjusted_outstanding).toFixed(2),
      pendingAdvances: num(r.pending_advances).toFixed(2),
      pendingOutstanding: num(r.pending_outstanding).toFixed(2),
      net: num(r.net_salary).toFixed(2),
      paymentStatus: r.payment_status || '',
      paymentMode: r.payment_mode || '',
      paymentDate: fmtDate(r.payment_date),
      bankAccount: r.bank_account || '',
      bankIfsc: r.bank_ifsc || '',
      paidBy: r.paid_by_name || '',
      notes: r.notes || '',
      createdAt: fmtDateTime(r.created_at),
    });
  }

  styleHeader(ws);
  return sendWorkbook(res, wb, `Salaries_Report_${month || 'all'}_${year || 'all'}.xlsx`);
}

/* ═══════════════════════════════════════════════════════════════════════════
   5. INVENTORY REPORT
   ═══════════════════════════════════════════════════════════════════════════ */

async function exportInventory(req, res) {
  const { startDate, endDate } = req.query;
  const rId = req.user.restaurantId;

  // Sheet 1: Current stock
  const [items] = await query(
    `SELECT ii.*, ic.name AS category_name
     FROM inventory_items ii
     LEFT JOIN inventory_categories ic ON ic.id = ii.category_id
     WHERE ii.restaurant_id = ?
     ORDER BY ic.name ASC, ii.name ASC`,
    [rId]
  );

  // Sheet 2: Transactions
  const df = dateFilter(startDate, endDate, 'it');
  const [transactions] = await query(
    `SELECT it.*, ii.name AS item_name, ii.unit, u.name AS performed_by_name
     FROM inventory_transactions it
     JOIN inventory_items ii ON ii.id = it.item_id
     LEFT JOIN users u ON u.id = it.performed_by
     WHERE it.restaurant_id = ? ${df.sql}
     ORDER BY it.created_at DESC`,
    [rId, ...df.params]
  );

  const wb = new ExcelJS.Workbook();
  wb.creator = 'DineSys';

  // ── Sheet 1: Stock Summary ──
  const ws1 = wb.addWorksheet('Current Stock');
  ws1.columns = [
    { header: 'Item ID', key: 'id', width: 10 },
    { header: 'Item Name', key: 'name', width: 24 },
    { header: 'Category', key: 'category', width: 18 },
    { header: 'SKU', key: 'sku', width: 14 },
    { header: 'Unit', key: 'unit', width: 10 },
    { header: 'Current Stock', key: 'stock', width: 14 },
    { header: 'Minimum Stock', key: 'minStock', width: 14 },
    { header: 'Reorder Level', key: 'reorder', width: 14 },
    { header: 'Cost Per Unit (₹)', key: 'cost', width: 16 },
    { header: 'Stock Value (₹)', key: 'value', width: 16 },
    { header: 'Supplier Name', key: 'supplier', width: 20 },
    { header: 'Supplier Phone', key: 'supplierPhone', width: 16 },
    { header: 'Status', key: 'status', width: 14 },
  ];

  for (const item of items) {
    const stock = num(item.current_stock);
    const min = num(item.minimum_stock);
    ws1.addRow({
      id: item.id,
      name: item.name,
      category: item.category_name || '',
      sku: item.sku || '',
      unit: item.unit || item.unit_display || '',
      stock: stock,
      minStock: min,
      reorder: num(item.reorder_level),
      cost: num(item.cost_per_unit).toFixed(2),
      value: (stock * num(item.cost_per_unit)).toFixed(2),
      supplier: item.supplier_name || '',
      supplierPhone: item.supplier_phone || '',
      status: stock <= min ? 'LOW STOCK' : 'OK',
    });
  }
  styleHeader(ws1);

  // ── Sheet 2: Transactions ──
  const ws2 = wb.addWorksheet('Transactions');
  ws2.columns = [
    { header: 'Date', key: 'date', width: 20 },
    { header: 'Item Name', key: 'item', width: 24 },
    { header: 'Type', key: 'type', width: 14 },
    { header: 'Quantity', key: 'qty', width: 12 },
    { header: 'Unit', key: 'unit', width: 10 },
    { header: 'Previous Stock', key: 'prev', width: 14 },
    { header: 'New Stock', key: 'new', width: 14 },
    { header: 'Unit Cost (₹)', key: 'unitCost', width: 14 },
    { header: 'Total Cost (₹)', key: 'totalCost', width: 14 },
    { header: 'Reference #', key: 'ref', width: 16 },
    { header: 'Performed By', key: 'by', width: 18 },
    { header: 'Notes', key: 'notes', width: 24 },
  ];

  for (const t of transactions) {
    ws2.addRow({
      date: fmtDateTime(t.created_at),
      item: t.item_name,
      type: t.transaction_type?.replace('_', ' ').toUpperCase(),
      qty: num(t.quantity),
      unit: t.unit || '',
      prev: num(t.previous_stock),
      new: num(t.new_stock),
      unitCost: num(t.unit_cost).toFixed(2),
      totalCost: num(t.total_cost).toFixed(2),
      ref: t.reference_number || '',
      by: t.performed_by_name || '',
      notes: t.notes || '',
    });
  }
  styleHeader(ws2);

  return sendWorkbook(res, wb, `Inventory_Report_${startDate || 'all'}_to_${endDate || 'all'}.xlsx`);
}

/* ═══════════════════════════════════════════════════════════════════════════
   6. EXPENSES REPORT
   ═══════════════════════════════════════════════════════════════════════════ */

async function exportExpenses(req, res) {
  const { startDate, endDate } = req.query;
  const rId = req.user.restaurantId;

  let where = 'WHERE e.restaurant_id = ?';
  const params = [rId];
  if (startDate) { where += ' AND DATE(e.expense_date) >= ?'; params.push(startDate); }
  if (endDate) { where += ' AND DATE(e.expense_date) <= ?'; params.push(endDate); }

  const [rows] = await query(
    `SELECT e.*, ec.name AS category_name,
            u.name AS created_by_name, a.name AS approved_by_name
     FROM expenses e
     LEFT JOIN expense_categories ec ON ec.id = e.category_id
     LEFT JOIN users u ON u.id = e.created_by
     LEFT JOIN users a ON a.id = e.approved_by
     ${where}
     ORDER BY e.expense_date DESC`,
    params
  );

  const wb = new ExcelJS.Workbook();
  wb.creator = 'DineSys';
  const ws = wb.addWorksheet('Expenses');

  ws.columns = [
    { header: 'Expense ID', key: 'id', width: 12 },
    { header: 'Date', key: 'date', width: 16 },
    { header: 'Title', key: 'title', width: 26 },
    { header: 'Category', key: 'category', width: 18 },
    { header: 'Amount (₹)', key: 'amount', width: 14 },
    { header: 'Payment Mode', key: 'paymentMode', width: 16 },
    { header: 'Status', key: 'status', width: 14 },
    { header: 'Vendor Name', key: 'vendor', width: 20 },
    { header: 'Created By', key: 'createdBy', width: 18 },
    { header: 'Approved By', key: 'approvedBy', width: 18 },
    { header: 'Approval Notes', key: 'approvedNotes', width: 24 },
    { header: 'Notes', key: 'notes', width: 28 },
    { header: 'Receipt', key: 'receipt', width: 14 },
    { header: 'Created At', key: 'createdAt', width: 18 },
  ];

  for (const e of rows) {
    ws.addRow({
      id: e.id,
      date: fmtDate(e.expense_date),
      title: e.title,
      category: e.category_name || 'Uncategorized',
      amount: num(e.amount).toFixed(2),
      paymentMode: e.payment_mode || '',
      status: e.status,
      vendor: e.vendor_name || '',
      createdBy: e.created_by_name || '',
      approvedBy: e.approved_by_name || '',
      approvedNotes: e.approved_notes || '',
      notes: e.notes || '',
      receipt: e.receipt_url ? 'Yes' : 'No',
      createdAt: fmtDateTime(e.created_at),
    });
  }

  // Summary row
  const totalAmount = rows.reduce((s, e) => s + num(e.amount), 0);
  const approvedTotal = rows.filter(e => e.status === 'approved').reduce((s, e) => s + num(e.amount), 0);
  const pendingTotal = rows.filter(e => e.status === 'pending').reduce((s, e) => s + num(e.amount), 0);

  ws.addRow({});
  const summaryRow = ws.addRow({ title: 'TOTAL', amount: totalAmount.toFixed(2) });
  summaryRow.font = { bold: true };
  ws.addRow({ title: 'Approved Total', amount: approvedTotal.toFixed(2) });
  ws.addRow({ title: 'Pending Total', amount: pendingTotal.toFixed(2) });

  styleHeader(ws);
  return sendWorkbook(res, wb, `Expenses_Report_${startDate || 'all'}_to_${endDate || 'all'}.xlsx`);
}

/* ═══════════════════════════════════════════════════════════════════════════
   7. ATTENDANCE REPORT
   ═══════════════════════════════════════════════════════════════════════════ */

async function exportAttendance(req, res) {
  const { startDate, endDate, employeeId } = req.query;
  const rId = req.user.restaurantId;

  let where = 'WHERE ar.restaurant_id = ?';
  const params = [rId];

  if (employeeId) { where += ' AND ar.employee_id = ?'; params.push(employeeId); }
  if (startDate) { where += ' AND ar.attendance_date >= ?'; params.push(startDate); }
  if (endDate) { where += ' AND ar.attendance_date <= ?'; params.push(endDate); }

  const [rows] = await query(
    `SELECT ar.*, e.name AS employee_name, e.phone AS employee_phone,
            e.department, e.designation
     FROM attendance_records ar
     JOIN employees e ON e.id = ar.employee_id
     ${where}
     ORDER BY ar.attendance_date DESC, e.name ASC`,
    params
  );

  // Build per-employee summary
  const empMap = {};
  for (const r of rows) {
    const eid = r.employee_id;
    if (!empMap[eid]) {
      empMap[eid] = { name: r.employee_name, department: r.department, designation: r.designation, present: 0, absent: 0, half_day: 0, leave: 0, total: 0 };
    }
    empMap[eid].total++;
    if (r.status === 'present') empMap[eid].present++;
    else if (r.status === 'absent') empMap[eid].absent++;
    else if (r.status === 'half_day') empMap[eid].half_day++;
    else if (r.status === 'leave') empMap[eid].leave++;
  }

  const wb = new ExcelJS.Workbook();
  wb.creator = 'DineSys';

  // ── Sheet 1: Attendance Records ──
  const ws1 = wb.addWorksheet('Attendance Records');
  ws1.columns = [
    { header: 'Date', key: 'date', width: 14 },
    { header: 'Day', key: 'day', width: 12 },
    { header: 'Employee Name', key: 'name', width: 22 },
    { header: 'Department', key: 'department', width: 16 },
    { header: 'Designation', key: 'designation', width: 18 },
    { header: 'Phone', key: 'phone', width: 16 },
    { header: 'Status', key: 'status', width: 12 },
    { header: 'Check In', key: 'checkIn', width: 12 },
    { header: 'Check Out', key: 'checkOut', width: 12 },
    { header: 'Working Hours', key: 'workingHours', width: 14 },
    { header: 'Notes', key: 'notes', width: 28 },
  ];

  const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

  for (const r of rows) {
    const d = r.attendance_date ? new Date(r.attendance_date) : null;
    const dayName = d ? dayNames[d.getDay()] : '';

    // Calculate working hours from check_in / check_out
    let workingHours = '';
    if (r.check_in && r.check_out) {
      const [inH, inM] = r.check_in.split(':').map(Number);
      const [outH, outM] = r.check_out.split(':').map(Number);
      const diffMins = (outH * 60 + outM) - (inH * 60 + inM);
      if (diffMins > 0) {
        const hrs = Math.floor(diffMins / 60);
        const mins = diffMins % 60;
        workingHours = `${hrs}h ${mins}m`;
      }
    }

    const row = ws1.addRow({
      date: fmtDate(r.attendance_date),
      day: dayName,
      name: r.employee_name || '',
      department: r.department || '',
      designation: r.designation || '',
      phone: r.employee_phone || '',
      status: (r.status || '').replace('_', ' ').replace(/\b\w/g, c => c.toUpperCase()),
      checkIn: r.check_in || '',
      checkOut: r.check_out || '',
      workingHours,
      notes: r.notes || '',
    });

    // Color-code status cell
    const statusCell = row.getCell('status');
    if (r.status === 'present') statusCell.font = { color: { argb: 'FF16A34A' }, bold: true };
    else if (r.status === 'absent') statusCell.font = { color: { argb: 'FFDC2626' }, bold: true };
    else if (r.status === 'half_day') statusCell.font = { color: { argb: 'FFF59E0B' }, bold: true };
    else if (r.status === 'leave') statusCell.font = { color: { argb: 'FF3B82F6' }, bold: true };
  }
  styleHeader(ws1);

  // ── Sheet 2: Employee-wise Summary ──
  const ws2 = wb.addWorksheet('Attendance Summary');
  ws2.columns = [
    { header: 'Employee Name', key: 'name', width: 22 },
    { header: 'Department', key: 'department', width: 16 },
    { header: 'Designation', key: 'designation', width: 18 },
    { header: 'Total Days', key: 'total', width: 12 },
    { header: 'Present', key: 'present', width: 10 },
    { header: 'Absent', key: 'absent', width: 10 },
    { header: 'Half Day', key: 'halfDay', width: 10 },
    { header: 'Leave', key: 'leave', width: 10 },
    { header: 'Attendance %', key: 'percentage', width: 14 },
  ];

  for (const eid of Object.keys(empMap)) {
    const e = empMap[eid];
    const effectiveDays = e.present + (e.half_day * 0.5);
    const pct = e.total > 0 ? ((effectiveDays / e.total) * 100).toFixed(1) : '0.0';
    ws2.addRow({
      name: e.name,
      department: e.department || '',
      designation: e.designation || '',
      total: e.total,
      present: e.present,
      absent: e.absent,
      halfDay: e.half_day,
      leave: e.leave,
      percentage: `${pct}%`,
    });
  }
  styleHeader(ws2);

  return sendWorkbook(res, wb, `Attendance_Report_${startDate || 'all'}_to_${endDate || 'all'}.xlsx`);
}

module.exports = {
  exportCustomers, exportOrders, exportEmployees,
  exportSalaries, exportInventory, exportExpenses, exportAttendance,
};
