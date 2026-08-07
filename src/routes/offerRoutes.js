const express = require('express');
const {
  listOffers,
  createOffer,
  updateOffer,
  deleteOffer,
  restoreOffer
} = require('../controllers/offerController');
const { authenticate, authenticateOptional, requireAdmin } = require('../middleware/auth');

const router = express.Router();

router.get('/', authenticateOptional, listOffers);
router.post('/', authenticate, requireAdmin, createOffer);
router.put('/:id', authenticate, requireAdmin, updateOffer);
router.delete('/:id', authenticate, requireAdmin, deleteOffer);
router.put('/:id/restore', authenticate, requireAdmin, restoreOffer);

module.exports = router;
