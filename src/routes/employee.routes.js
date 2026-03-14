'use strict';

const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/auth');
const { requireRole } = require('../middleware/roleCheck');
const { requireFeature } = require('../middleware/featureCheck');
const ctrl = require('../controllers/employee.controller');

const auth = [authenticate, requireFeature('feature_employee_management')];
const mgr  = [authenticate, requireRole('owner', 'manager'), requireFeature('feature_employee_management')];

router.get('/', ...mgr, ctrl.getEmployees);
router.get('/attendance', ...mgr, ctrl.getAttendance);
router.get('/salary', ...mgr, ctrl.getSalaryRecords);
router.get('/advances', ...mgr, ctrl.getAdvances);
router.get('/:employeeId', ...mgr, ctrl.getEmployeeById);
router.get('/:employeeId/advance-summary', ...mgr, ctrl.getPendingAdvanceSummary);
router.post('/', ...mgr, ctrl.createEmployee);
router.put('/:employeeId', ...mgr, ctrl.updateEmployee);
router.delete('/:employeeId', ...mgr, ctrl.deleteEmployee);

router.post('/:employeeId/attendance', ...mgr, ctrl.markAttendance);
router.post('/:employeeId/salary', ...mgr, ctrl.processSalary);
router.put('/:employeeId/salary/:salaryId', ...mgr, ctrl.updateSalary);
router.delete('/:employeeId/salary/:salaryId', ...mgr, ctrl.deleteSalary);
router.patch('/:employeeId/salary/:salaryId/status', ...mgr, ctrl.updateSalaryStatus);

router.post('/advances', ...mgr, ctrl.createAdvance);
router.put('/advances/:advanceId', ...mgr, ctrl.updateAdvance);
router.delete('/advances/:advanceId', ...mgr, ctrl.deleteAdvance);

module.exports = router;
