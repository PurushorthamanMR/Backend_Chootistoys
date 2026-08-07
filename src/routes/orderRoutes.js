const express = require('express');
const {
  placeOrder,
  listMyOrders,
  listAllOrders,
  updateOrderStatus,
  processReturn
} = require('../controllers/orderController');
const { authenticate, requireAdmin } = require('../middleware/auth');

const router = express.Router();

router.post('/', authenticate, placeOrder);
router.get('/mine', authenticate, listMyOrders);
router.get('/', authenticate, requireAdmin, listAllOrders);
router.put('/:id/status', authenticate, requireAdmin, updateOrderStatus);
router.put('/:id/return', authenticate, requireAdmin, processReturn);

module.exports = router;
