const express = require('express');
const {
  listSubcategories,
  createSubcategory,
  updateSubcategory,
  deleteSubcategory,
  restoreSubcategory,
  checkSubcategoryName,
} = require('../controllers/subcategoryController');
const { authenticate, authenticateOptional, requireAdmin } = require('../middleware/auth');

const router = express.Router();

router.get('/', authenticateOptional, listSubcategories);
router.get('/check-name', authenticate, requireAdmin, checkSubcategoryName);
router.post('/', authenticate, requireAdmin, createSubcategory);
router.put('/:id', authenticate, requireAdmin, updateSubcategory);
router.delete('/:id', authenticate, requireAdmin, deleteSubcategory);
router.put('/:id/restore', authenticate, requireAdmin, restoreSubcategory);

module.exports = router;
