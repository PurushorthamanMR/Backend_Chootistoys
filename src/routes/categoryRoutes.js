const express = require('express');
const {
  listCategories,
  createCategory,
  updateCategory,
  deleteCategory,
  restoreCategory,
  checkCategoryName
} = require('../controllers/categoryController');
const { authenticate, authenticateOptional, requireAdmin } = require('../middleware/auth');

const router = express.Router();

router.get('/', authenticateOptional, listCategories);
router.get('/check-name', authenticate, requireAdmin, checkCategoryName);
router.post('/', authenticate, requireAdmin, createCategory);
router.put('/:id', authenticate, requireAdmin, updateCategory);
router.delete('/:id', authenticate, requireAdmin, deleteCategory);
router.put('/:id/restore', authenticate, requireAdmin, restoreCategory);

module.exports = router;
