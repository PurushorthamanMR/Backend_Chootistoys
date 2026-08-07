const express = require('express');
const pool = require('../config/db');
const { sendOrderRequest } = require('../controllers/whatsappController');
const { authenticateOptional } = require('../middleware/auth');
const { getWhatsappNumber } = require('../utils/settings');

const router = express.Router();

router.get('/contact', async (req, res) => {
  res.json({ number: await getWhatsappNumber(pool) });
});
router.post('/send', authenticateOptional, sendOrderRequest);

module.exports = router;
