const express = require('express');
const {
  openShift,
  getCurrentShift,
  closeShift,
  createSale,
  voidSale,
  addSalePayment,
  processSaleReturn,
  listSales,
  getSaleItems,
  getDailyReport,
  getStaffSalesReport,
  getXReport,
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
// Settling a balance is a normal cashier action, unlike void/return below.
router.post('/sales/:id/payments', addSalePayment);
// Return is Admin/SuperAdmin only, same reasoning as void.
router.post('/sales/:id/return', requireAdmin, processSaleReturn);

router.get('/reports/daily', getDailyReport);
// Admin/SuperAdmin only - per-staff breakdown, not a cashier's own numbers.
router.get('/reports/staff-sales', requireAdmin, getStaffSalesReport);
router.get('/reports/x-report', getXReport);

router.post('/holds', createHold);
router.get('/holds', listHolds);
router.delete('/holds/:id', deleteHold);

module.exports = router;
