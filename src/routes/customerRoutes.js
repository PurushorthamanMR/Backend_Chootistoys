const express = require('express');
const {
  listCustomers,
  updateCustomer,
  deactivateCustomer,
  restoreCustomer,
  checkCustomerField,
} = require('../controllers/customerController');
const { authenticate, authenticateOptional, requireAdmin, requirePos } = require('../middleware/auth');

const router = express.Router();

router.get('/check', authenticateOptional, checkCustomerField);
// requirePos (not requireAdmin) - the POS customer picker needs Staff to be
// able to search customers too, mutations below stay Admin/SuperAdmin-only.
router.get('/', authenticate, requirePos, listCustomers);
router.put('/:id', authenticate, requireAdmin, updateCustomer);
router.delete('/:id', authenticate, requireAdmin, deactivateCustomer);
router.put('/:id/restore', authenticate, requireAdmin, restoreCustomer);

module.exports = router;
