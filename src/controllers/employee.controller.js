'use strict';

const { query, transaction } = require('../config/database');
const { success, error } = require('../utils/responseHelper');
const { HTTP_STATUS } = require('../config/constants');

/* ─── employees ────────────────────────────────────────────────────────────── */

async function getEmployees(req, res) {
  const { department, isActive } = req.query;
  let where = 'WHERE e.restaurant_id = ?';
  const params = [req.user.restaurantId];
  if (department) { where += ' AND e.department = ?'; params.push(department); }
  if (isActive !== undefined) { where += ' AND e.is_active = ?'; params.push(isActive === 'true' ? 1 : 0); }

  const [rows] = await query(
    `SELECT e.*, u.email, u.role AS system_role
     FROM employees e
     LEFT JOIN users u ON u.id = e.user_id
     ${where}
     ORDER BY e.name ASC`,
    params
  );
  return success(res, rows);
}

async function getEmployeeById(req, res) {
  const { employeeId } = req.params;
  const [rows] = await query(
    `SELECT e.*, u.email, u.role AS system_role
     FROM employees e
     LEFT JOIN users u ON u.id = e.user_id
     WHERE e.id = ? AND e.restaurant_id = ? LIMIT 1`,
    [employeeId, req.user.restaurantId]
  );
  if (!rows || rows.length === 0) return error(res, 'Employee not found.', HTTP_STATUS.NOT_FOUND);

  const [salaryRecords] = await query(
    'SELECT * FROM salary_records WHERE employee_id = ? ORDER BY year DESC, month DESC LIMIT 12',
    [employeeId]
  );
  const [attendance] = await query(
    'SELECT * FROM attendance_records WHERE employee_id = ? ORDER BY attendance_date DESC LIMIT 31',
    [employeeId]
  );

  return success(res, { ...rows[0], salaryRecords, recentAttendance: attendance });
}

async function createEmployee(req, res) {
  const { name, phone, department, designation, baseSalary, joiningDate, userId } = req.body;
  if (!name) return error(res, 'name is required.', HTTP_STATUS.BAD_REQUEST);

  const [result] = await query(
    `INSERT INTO employees (restaurant_id, user_id, name, phone, department, designation, base_salary, joining_date, role)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      req.user.restaurantId, userId || null, name, phone || null,
      department || null, designation || null, baseSalary || 0,
      joiningDate || new Date().toISOString().split('T')[0],
      designation || department || 'Staff'
    ]
  );
  return success(res, { id: result.insertId }, 'Employee created.', HTTP_STATUS.CREATED);
}

async function updateEmployee(req, res) {
  const { employeeId } = req.params;
  const { name, phone, department, designation, baseSalary, isActive } = req.body;

  await query(
    `UPDATE employees SET
       name = COALESCE(?, name),
       phone = COALESCE(?, phone),
       department = COALESCE(?, department),
       designation = COALESCE(?, designation),
       base_salary = COALESCE(?, base_salary),
       is_active = COALESCE(?, is_active)
     WHERE id = ? AND restaurant_id = ?`,
    [name || null, phone || null, department || null, designation || null, baseSalary ?? null, isActive ?? null, employeeId, req.user.restaurantId]
  );
  return success(res, null, 'Employee updated.');
}

async function deleteEmployee(req, res) {
  const { employeeId } = req.params;
  await query('UPDATE employees SET is_active = 0 WHERE id = ? AND restaurant_id = ?', [employeeId, req.user.restaurantId]);
  return success(res, null, 'Employee deactivated.');
}

/* ─── attendance ───────────────────────────────────────────────────────────── */

async function markAttendance(req, res) {
  const { employeeId } = req.params;
  const { date, status, checkIn, checkOut, notes } = req.body;
  if (!date || !status) return error(res, 'date and status are required.', HTTP_STATUS.BAD_REQUEST);
  const validStatuses = ['present', 'absent', 'half_day', 'leave', 'holiday'];
  if (!validStatuses.includes(status)) return error(res, 'Invalid attendance status.', HTTP_STATUS.BAD_REQUEST);

  const [empRows] = await query('SELECT id FROM employees WHERE id = ? AND restaurant_id = ? LIMIT 1', [employeeId, req.user.restaurantId]);
  if (!empRows || empRows.length === 0) return error(res, 'Employee not found.', HTTP_STATUS.NOT_FOUND);

  const [existing] = await query('SELECT id FROM attendance_records WHERE employee_id = ? AND attendance_date = ? LIMIT 1', [employeeId, date]);
  if (existing && existing.length > 0) {
    await query(
      'UPDATE attendance_records SET status = ?, check_in = ?, check_out = ?, notes = ? WHERE id = ?',
      [status, checkIn || null, checkOut || null, notes || null, existing[0].id]
    );
  } else {
    await query(
      'INSERT INTO attendance_records (employee_id, restaurant_id, attendance_date, status, check_in, check_out, notes) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [employeeId, req.user.restaurantId, date, status, checkIn || null, checkOut || null, notes || null]
    );
  }
  return success(res, null, 'Attendance marked.');
}

async function getAttendance(req, res) {
  const { employeeId, month, year, date } = req.query;
  let where = 'WHERE ar.restaurant_id = ?';
  const params = [req.user.restaurantId];
  if (employeeId) { where += ' AND ar.employee_id = ?'; params.push(employeeId); }
  if (date) {
    // Single date filter — show all employees for that date
    where += ' AND ar.attendance_date = ?';
    params.push(date);
  } else if (month && year) {
    where += ' AND MONTH(ar.attendance_date) = ? AND YEAR(ar.attendance_date) = ?';
    params.push(month, year);
  }

  const [rows] = await query(
    `SELECT ar.*, e.name AS employee_name, e.department
     FROM attendance_records ar
     JOIN employees e ON e.id = ar.employee_id
     ${where}
     ORDER BY ar.attendance_date DESC, e.name ASC`,
    params
  );
  return success(res, rows);
}

/* ─── salary ───────────────────────────────────────────────────────────────── */

async function getSalaryRecords(req, res) {
  const { employeeId, month, year } = req.query;
  let where = 'WHERE sr.restaurant_id = ?';
  const params = [req.user.restaurantId];
  if (employeeId) { where += ' AND sr.employee_id = ?'; params.push(employeeId); }
  if (month) { where += ' AND sr.month = ?'; params.push(month); }
  if (year) { where += ' AND sr.year = ?'; params.push(year); }

  const [rows] = await query(
    `SELECT sr.*, e.name AS employee_name, e.department
     FROM salary_records sr
     JOIN employees e ON e.id = sr.employee_id
     ${where}
     ORDER BY sr.year DESC, sr.month DESC`,
    params
  );
  return success(res, rows);
}

async function processSalary(req, res) {
  const { employeeId } = req.params;
  const { month, year, basicSalary, bonuses, deductions, adjustAdvances, adjustOutstanding, paymentDate, notes } = req.body;
  if (!month || !year || !basicSalary) return error(res, 'month, year and basicSalary are required.', HTTP_STATUS.BAD_REQUEST);

  const [empRows] = await query('SELECT id FROM employees WHERE id = ? AND restaurant_id = ? LIMIT 1', [employeeId, req.user.restaurantId]);
  if (!empRows || empRows.length === 0) return error(res, 'Employee not found.', HTTP_STATUS.NOT_FOUND);

  const [existing] = await query('SELECT id FROM salary_records WHERE employee_id = ? AND month = ? AND year = ? LIMIT 1', [employeeId, month, year]);
  if (existing && existing.length > 0) return error(res, 'Salary already processed for this period.', HTTP_STATUS.CONFLICT);

  // Salary = basic + bonuses - deductions (NOT affected by advances/outstanding)
  const netSalary = parseFloat(basicSalary) + parseFloat(bonuses || 0) - parseFloat(deductions || 0);

  // Owner-specified adjustment amounts (may be partial)
  const adjAdvances = parseFloat(adjustAdvances || 0);
  const adjOutstanding = parseFloat(adjustOutstanding || 0);

  const result = await transaction(async (conn) => {
    const [insertRes] = await conn.execute(
      `INSERT INTO salary_records (employee_id, restaurant_id, month, year, base_salary, basic_salary, bonuses, adjusted_advances, adjusted_outstanding, deductions, net_salary, payment_date, notes, paid_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [employeeId, req.user.restaurantId, month, year, basicSalary, basicSalary, bonuses || 0, adjAdvances, adjOutstanding, deductions || 0, netSalary, paymentDate || null, notes || null, req.user.id]
    );
    const salaryId = insertRes.insertId;

    // Partially deduct from pending advance records (FIFO by date)
    if (adjAdvances > 0) {
      await deductFromPendingRecords(conn, employeeId, req.user.restaurantId, 'advance', adjAdvances, salaryId);
    }
    if (adjOutstanding > 0) {
      await deductFromPendingRecords(conn, employeeId, req.user.restaurantId, 'outstanding', adjOutstanding, salaryId);
    }

    return { id: salaryId, netSalary };
  });

  return success(res, result, 'Salary processed.', HTTP_STATUS.CREATED);
}

// Helper: partially deduct amount from pending advance/outstanding records (FIFO)
async function deductFromPendingRecords(conn, employeeId, restaurantId, type, amount, salaryId) {
  const [rows] = await conn.execute(
    `SELECT id, remaining FROM employee_advances
     WHERE employee_id = ? AND restaurant_id = ? AND type = ? AND status = 'pending' AND remaining > 0
     ORDER BY date ASC`,
    [employeeId, restaurantId, type]
  );

  let left = amount;
  for (const record of (rows || [])) {
    if (left <= 0) break;
    const recRemaining = parseFloat(record.remaining);
    const deduct = Math.min(left, recRemaining);
    const newRemaining = recRemaining - deduct;

    if (newRemaining <= 0) {
      await conn.execute(
        `UPDATE employee_advances SET remaining = 0, status = 'adjusted', adjusted_in_salary_id = ? WHERE id = ?`,
        [salaryId, record.id]
      );
    } else {
      await conn.execute(
        `UPDATE employee_advances SET remaining = ? WHERE id = ?`,
        [newRemaining, record.id]
      );
    }
    left -= deduct;
  }
}

async function updateSalary(req, res) {
  const { employeeId, salaryId } = req.params;
  const { basicSalary, bonuses, deductions, notes } = req.body;

  const [rows] = await query('SELECT * FROM salary_records WHERE id = ? AND employee_id = ? AND restaurant_id = ? LIMIT 1', [salaryId, employeeId, req.user.restaurantId]);
  if (!rows || rows.length === 0) return error(res, 'Salary record not found.', HTTP_STATUS.NOT_FOUND);

  const basic = basicSalary !== undefined ? parseFloat(basicSalary) : parseFloat(rows[0].basic_salary || rows[0].base_salary || 0);
  const bon = bonuses !== undefined ? parseFloat(bonuses) : parseFloat(rows[0].bonuses || 0);
  const ded = deductions !== undefined ? parseFloat(deductions) : parseFloat(rows[0].deductions || 0);
  const netSalary = basic + bon - ded;

  await query(
    'UPDATE salary_records SET base_salary = ?, basic_salary = ?, bonuses = ?, deductions = ?, net_salary = ?, notes = COALESCE(?, notes) WHERE id = ?',
    [basic, basic, bon, ded, netSalary, notes !== undefined ? (notes || null) : null, salaryId]
  );
  return success(res, null, 'Salary record updated.');
}

async function deleteSalary(req, res) {
  const { employeeId, salaryId } = req.params;
  const [rows] = await query('SELECT id FROM salary_records WHERE id = ? AND employee_id = ? AND restaurant_id = ? LIMIT 1', [salaryId, employeeId, req.user.restaurantId]);
  if (!rows || rows.length === 0) return error(res, 'Salary record not found.', HTTP_STATUS.NOT_FOUND);
  await query('DELETE FROM salary_records WHERE id = ?', [salaryId]);
  return success(res, null, 'Salary record deleted.');
}

async function updateSalaryStatus(req, res) {
  const { employeeId, salaryId } = req.params;
  const { paymentStatus, paymentDate, paymentMode } = req.body;
  if (!['pending', 'paid'].includes(paymentStatus)) return error(res, 'Invalid status.', HTTP_STATUS.BAD_REQUEST);

  const [rows] = await query('SELECT id FROM salary_records WHERE id = ? AND employee_id = ? AND restaurant_id = ? LIMIT 1', [salaryId, employeeId, req.user.restaurantId]);
  if (!rows || rows.length === 0) return error(res, 'Salary record not found.', HTTP_STATUS.NOT_FOUND);

  await query(
    'UPDATE salary_records SET payment_status = ?, payment_date = COALESCE(?, payment_date), payment_mode = COALESCE(?, payment_mode), paid_by = ? WHERE id = ?',
    [paymentStatus, paymentDate || null, paymentMode || null, req.user.id, salaryId]
  );
  return success(res, null, `Salary marked as ${paymentStatus}.`);
}

/* ─── employee advances / outstanding ──────────────────────────────────────── */

async function getAdvances(req, res) {
  const { employeeId, status } = req.query;
  let where = 'WHERE ea.restaurant_id = ?';
  const params = [req.user.restaurantId];
  if (employeeId) { where += ' AND ea.employee_id = ?'; params.push(employeeId); }
  if (status) { where += ' AND ea.status = ?'; params.push(status); }

  const [rows] = await query(
    `SELECT ea.*, e.name AS employee_name, e.department, u.name AS created_by_name
     FROM employee_advances ea
     JOIN employees e ON e.id = ea.employee_id
     LEFT JOIN users u ON u.id = ea.created_by
     ${where}
     ORDER BY ea.date DESC`,
    params
  );
  return success(res, rows);
}

async function createAdvance(req, res) {
  const { employeeId, type, amount, date, notes } = req.body;
  if (!employeeId || !amount || !date) return error(res, 'employeeId, amount and date are required.', HTTP_STATUS.BAD_REQUEST);

  const [empRows] = await query('SELECT id, name FROM employees WHERE id = ? AND restaurant_id = ? LIMIT 1', [employeeId, req.user.restaurantId]);
  if (!empRows || empRows.length === 0) return error(res, 'Employee not found.', HTTP_STATUS.NOT_FOUND);

  const [result] = await query(
    'INSERT INTO employee_advances (restaurant_id, employee_id, type, amount, remaining, date, notes, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [req.user.restaurantId, employeeId, type || 'advance', amount, amount, date, notes || null, req.user.id]
  );
  return success(res, { id: result.insertId }, `${(type || 'advance').charAt(0).toUpperCase() + (type || 'advance').slice(1)} recorded.`, HTTP_STATUS.CREATED);
}

async function updateAdvance(req, res) {
  const { advanceId } = req.params;
  const { amount, date, notes, status } = req.body;

  const [rows] = await query('SELECT * FROM employee_advances WHERE id = ? AND restaurant_id = ? LIMIT 1', [advanceId, req.user.restaurantId]);
  if (!rows || rows.length === 0) return error(res, 'Record not found.', HTTP_STATUS.NOT_FOUND);

  // If amount changes on a pending record, update remaining proportionally
  let newRemaining = null;
  if (amount !== undefined && rows[0].status === 'pending') {
    const oldAmount = parseFloat(rows[0].amount);
    const oldRemaining = parseFloat(rows[0].remaining);
    const diff = parseFloat(amount) - oldAmount;
    newRemaining = Math.max(0, oldRemaining + diff);
  }

  await query(
    `UPDATE employee_advances SET
       amount = COALESCE(?, amount),
       ${newRemaining !== null ? `remaining = ${newRemaining},` : ''}
       date = COALESCE(?, date),
       notes = COALESCE(?, notes),
       status = COALESCE(?, status)
     WHERE id = ?`,
    [amount ?? null, date || null, notes !== undefined ? (notes || null) : null, status || null, advanceId]
  );
  return success(res, null, 'Record updated.');
}

async function deleteAdvance(req, res) {
  const { advanceId } = req.params;
  const [rows] = await query('SELECT * FROM employee_advances WHERE id = ? AND restaurant_id = ? LIMIT 1', [advanceId, req.user.restaurantId]);
  if (!rows || rows.length === 0) return error(res, 'Record not found.', HTTP_STATUS.NOT_FOUND);
  if (rows[0].status === 'adjusted') return error(res, 'Cannot delete an adjusted advance.', HTTP_STATUS.BAD_REQUEST);

  await query('DELETE FROM employee_advances WHERE id = ?', [advanceId]);
  return success(res, null, 'Record deleted.');
}

async function getPendingAdvanceSummary(req, res) {
  const { employeeId } = req.params;
  const [rows] = await query(
    `SELECT
       COALESCE(SUM(CASE WHEN type = 'advance' THEN remaining ELSE 0 END), 0) AS total_advances,
       COALESCE(SUM(CASE WHEN type = 'outstanding' THEN remaining ELSE 0 END), 0) AS total_outstanding
     FROM employee_advances
     WHERE employee_id = ? AND restaurant_id = ? AND status = 'pending'`,
    [employeeId, req.user.restaurantId]
  );
  return success(res, rows[0]);
}

module.exports = {
  getEmployees, getEmployeeById, createEmployee, updateEmployee, deleteEmployee,
  markAttendance, getAttendance,
  getSalaryRecords, processSalary, updateSalary, deleteSalary, updateSalaryStatus,
  getAdvances, createAdvance, updateAdvance, deleteAdvance, getPendingAdvanceSummary,
};
