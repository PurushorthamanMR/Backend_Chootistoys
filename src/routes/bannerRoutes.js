const express = require('express');
const {
  listBanners,
  createBanner,
  updateBanner,
  deleteBanner,
  restoreBanner
} = require('../controllers/bannerController');
const { authenticate, authenticateOptional, requireAdmin } = require('../middleware/auth');

const router = express.Router();

router.get('/', authenticateOptional, listBanners);
router.post('/', authenticate, requireAdmin, createBanner);
router.put('/:id', authenticate, requireAdmin, updateBanner);
router.delete('/:id', authenticate, requireAdmin, deleteBanner);
router.put('/:id/restore', authenticate, requireAdmin, restoreBanner);

module.exports = router;
