'use strict';

const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/auth');
const { requireRole } = require('../middleware/roleCheck');
const { requireFeature } = require('../middleware/featureCheck');
const ctrl = require('../controllers/expense.controller');

const auth = [authenticate, requireFeature('feature_expense_management')];
const mgr  = [authenticate, requireRole('owner', 'manager'), requireFeature('feature_expense_management')];

router.get('/categories', ...auth, ctrl.getCategories);
router.post('/categories', ...mgr, ctrl.createCategory);
router.delete('/categories/:categoryId', ...mgr, ctrl.deleteCategory);

router.get('/summary', ...mgr, ctrl.getExpenseSummary);
router.get('/', ...auth, ctrl.getExpenses);
router.get('/:expenseId', ...auth, ctrl.getExpenseById);
router.post('/', ...auth, ctrl.createExpense);
router.put('/:expenseId', ...auth, ctrl.updateExpense);
router.patch('/:expenseId/approve', ...mgr, ctrl.approveExpense);
router.delete('/:expenseId', ...auth, ctrl.deleteExpense);

module.exports = router;
