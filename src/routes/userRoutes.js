const express = require('express');
const {
  listUsers,
  updateUserRole,
  updateUser,
  approveUser,
  rejectUser,
  checkUserField,
} = require('../controllers/userController');
const { sendStaffOtp, verifyStaffOtp } = require('../controllers/otpController');
const { authenticate, authenticateOptional, requireAdmin } = require('../middleware/auth');

const router = express.Router();

router.get('/check', authenticateOptional, checkUserField);
router.get('/', authenticate, requireAdmin, listUsers);
router.post('/staff/send-otp', authenticate, requireAdmin, sendStaffOtp);
router.post('/staff/verify-otp', authenticate, requireAdmin, verifyStaffOtp);
router.put('/:id', authenticate, requireAdmin, updateUser);
router.put('/:id/role', authenticate, requireAdmin, updateUserRole);
router.put('/:id/approve', authenticate, requireAdmin, approveUser);
router.put('/:id/reject', authenticate, requireAdmin, rejectUser);

module.exports = router;
