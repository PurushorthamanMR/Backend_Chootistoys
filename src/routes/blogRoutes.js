const express = require('express');
const {
  listBlogs,
  createBlog,
  updateBlog,
  deleteBlog,
  restoreBlog
} = require('../controllers/blogController');
const { authenticate, authenticateOptional, requireAdmin } = require('../middleware/auth');

const router = express.Router();

router.get('/', authenticateOptional, listBlogs);
router.post('/', authenticate, requireAdmin, createBlog);
router.put('/:id', authenticate, requireAdmin, updateBlog);
router.delete('/:id', authenticate, requireAdmin, deleteBlog);
router.put('/:id/restore', authenticate, requireAdmin, restoreBlog);

module.exports = router;
