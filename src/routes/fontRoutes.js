const express = require('express');
const { listFonts, addFont } = require('../controllers/fontController');
const { authenticate, requireAdmin } = require('../middleware/auth');

const router = express.Router();

router.get('/', listFonts);
router.post('/', authenticate, requireAdmin, addFont);

module.exports = router;
