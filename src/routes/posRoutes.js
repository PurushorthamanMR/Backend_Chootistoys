const express = require('express');
const {
  openShift,
  getCurrentShift,
  closeShift,
  createSale,
  voidSale,
  listSales,
  getSaleItems,
  getDailyReport,
  getStaffSalesReport,
  createHold,
  listHolds,
  deleteHold,
} = require('../controllers/posController');
const { authenticate, requirePos, requireAdmin } = require('../middleware/auth');

const router = express.Router();

router.use(authenticate, requirePos);

router.post('/shifts', openShift);
router.get('/shifts/current', getCurrentShift);
router.post('/shifts/:id/close', closeShift);

router.post('/sales', createSale);
router.get('/sales', listSales);
router.get('/sales/:id', getSaleItems);
// Void is Admin/SuperAdmin only - a cashier can't erase their own sales.
router.post('/sales/:id/void', requireAdmin, voidSale);

router.get('/reports/daily', getDailyReport);
// Admin/SuperAdmin only - per-staff breakdown, not a cashier's own numbers.
router.get('/reports/staff-sales', requireAdmin, getStaffSalesReport);

router.post('/holds', createHold);
router.get('/holds', listHolds);
router.delete('/holds/:id', deleteHold);

module.exports = router;
