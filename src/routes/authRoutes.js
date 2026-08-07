const express = require('express');
const { login, me, updateProfile } = require('../controllers/authController');
const {
  sendRegisterOtp,
  verifyRegisterOtp,
  sendSellerOtp,
  verifySellerOtp,
  sendForgotPasswordOtp,
  verifyForgotPasswordOtp,
  resetPassword,
  sendChangeEmailOtp,
  verifyChangeEmailOtp,
} = require('../controllers/otpController');
const { authenticate } = require('../middleware/auth');

const router = express.Router();

router.post('/register/send-otp', sendRegisterOtp);
router.post('/register/verify-otp', verifyRegisterOtp);
router.post('/apply-seller/send-otp', sendSellerOtp);
router.post('/apply-seller/verify-otp', verifySellerOtp);
router.post('/forgot-password/send-otp', sendForgotPasswordOtp);
router.post('/forgot-password/verify-otp', verifyForgotPasswordOtp);
router.post('/forgot-password/reset', resetPassword);
router.post('/change-email/send-otp', authenticate, sendChangeEmailOtp);
router.post('/change-email/verify-otp', authenticate, verifyChangeEmailOtp);
router.post('/login', login);
router.get('/me', authenticate, me);
router.put('/me', authenticate, updateProfile);

module.exports = router;
