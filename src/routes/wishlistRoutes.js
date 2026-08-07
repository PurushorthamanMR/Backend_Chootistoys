const express = require('express');
const { listWishlistIds, listWishlist, toggleWishlist } = require('../controllers/wishlistController');
const { authenticate } = require('../middleware/auth');

const router = express.Router();

router.get('/ids', authenticate, listWishlistIds);
router.get('/', authenticate, listWishlist);
router.post('/:productId/toggle', authenticate, toggleWishlist);

module.exports = router;
