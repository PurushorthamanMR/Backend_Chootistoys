const express = require('express');
const {
  listUsers,
  updateUserRole,
  updateUser,
  approveUser,
  rejectUser,
  checkUserField,
} = require('../controllers/userController');
const { authenticate, authenticateOptional, requireAdmin } = require('../middleware/auth');

const router = express.Router();

router.get('/check', authenticateOptional, checkUserField);
router.get('/', authenticate, requireAdmin, listUsers);
router.put('/:id', authenticate, requireAdmin, updateUser);
router.put('/:id/role', authenticate, requireAdmin, updateUserRole);
router.put('/:id/approve', authenticate, requireAdmin, approveUser);
router.put('/:id/reject', authenticate, requireAdmin, rejectUser);

module.exports = router;
