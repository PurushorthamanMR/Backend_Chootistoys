const express = require('express');
const { listWholesaleProducts } = require('../controllers/wholesaleController');

const router = express.Router();

router.get('/products', listWholesaleProducts);

module.exports = router;
