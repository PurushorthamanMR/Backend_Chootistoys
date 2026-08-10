const express = require('express');
const { listHomeSections, updateHomeSections } = require('../controllers/homeSectionsController');
const { authenticate, requireAdmin } = require('../middleware/auth');

const router = express.Router();

router.get('/', listHomeSections);
router.put('/', authenticate, requireAdmin, updateHomeSections);

module.exports = router;
