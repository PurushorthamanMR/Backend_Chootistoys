const express = require('express');
const {
  listCustomers,
  updateCustomer,
  deactivateCustomer,
  restoreCustomer,
  checkCustomerField,
} = require('../controllers/customerController');
const { authenticate, authenticateOptional, requireAdmin } = require('../middleware/auth');

const router = express.Router();

router.get('/check', authenticateOptional, checkCustomerField);
router.get('/', authenticate, requireAdmin, listCustomers);
router.put('/:id', authenticate, requireAdmin, updateCustomer);
router.delete('/:id', authenticate, requireAdmin, deactivateCustomer);
router.put('/:id/restore', authenticate, requireAdmin, restoreCustomer);

module.exports = router;
