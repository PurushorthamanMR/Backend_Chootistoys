const pool = require('../config/db');

function applyProductVisibility(row, user) {
  const role = user?.role;
  const canSeeCode = role === 'Admin' || role === 'SuperAdmin';
  const canSeeCost = canSeeCode || role === 'Seller';
  const result = { ...row };
  if (!canSeeCode) delete result.product_code;
  if (!canSeeCost) delete result.purchase_price;
  if (role === 'Seller') {
    delete result.sale_price;
    delete result.discount_percent;
    delete result.discount_price;
  }
  return result;
}

async function queryTopProducts(days, limit, requireInStock = false) {
  const dateFilter = days ? 'AND o.created_at >= NOW() - INTERVAL ? DAY' : '';
  const stockFilter = requireInStock ? 'AND p.stock > 0' : '';
  const params = days ? [days, limit] : [limit];
  const [rows] = await pool.query(
    `SELECT p.*, c.name AS category_name, c.slug AS category_slug,
            sc.name AS subcategory_name, sc.slug AS subcategory_slug,
            COALESCE(SUM(oi.quantity), 0) AS total_sold
     FROM products p
     JOIN order_items oi ON oi.product_id = p.id
     JOIN orders o ON o.id = oi.order_id
     LEFT JOIN categories c ON c.id = p.category_id
     LEFT JOIN subcategories sc ON sc.id = p.subcategory_id
     WHERE p.is_active = 1 AND o.status = 'successful' ${dateFilter} ${stockFilter}
     GROUP BY p.id
     ORDER BY total_sold DESC
     LIMIT ?`,
    params
  );
  return rows;
}

async function getHotSubcategories(req, res) {
  try {
    const limit = Number(req.query.limit) || 10;
    const [rows] = await pool.query(
      `SELECT sc.*, COALESCE(SUM(oi.quantity), 0) AS total_sold
       FROM subcategories sc
       JOIN products p ON p.subcategory_id = sc.id
       JOIN order_items oi ON oi.product_id = p.id
       JOIN orders o ON o.id = oi.order_id
       WHERE sc.is_active = 1 AND o.status = 'successful' AND o.created_at >= NOW() - INTERVAL 7 DAY
       GROUP BY sc.id
       ORDER BY total_sold DESC
       LIMIT ?`,
      [limit]
    );
    if (rows.length > 0) return res.json(rows);

    const [fallback] = await pool.query(
      'SELECT * FROM subcategories WHERE is_active = 1 ORDER BY name ASC LIMIT ?',
      [limit]
    );
    res.json(fallback);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Failed to fetch hot subcategories' });
  }
}

async function getHotCategories(req, res) {
  try {
    const limit = Number(req.query.limit) || 10;
    const [rows] = await pool.query(
      `SELECT c.*, COALESCE(SUM(oi.quantity), 0) AS total_sold
       FROM categories c
       JOIN products p ON p.category_id = c.id
       JOIN order_items oi ON oi.product_id = p.id
       JOIN orders o ON o.id = oi.order_id
       WHERE c.is_active = 1 AND o.status = 'successful' AND o.created_at >= NOW() - INTERVAL 7 DAY
       GROUP BY c.id
       ORDER BY total_sold DESC
       LIMIT ?`,
      [limit]
    );
    if (rows.length > 0) return res.json(rows);

    const [fallback] = await pool.query(
      'SELECT * FROM categories WHERE is_active = 1 ORDER BY name ASC LIMIT ?',
      [limit]
    );
    res.json(fallback);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Failed to fetch hot categories' });
  }
}

async function getFeaturedProducts(req, res) {
  try {
    const limit = Number(req.query.limit) || 3;
    const rows = await queryTopProducts(7, limit, true);
    if (rows.length > 0) return res.json(rows.map((r) => applyProductVisibility(r, req.user)));

    const [fallback] = await pool.query(
      `SELECT p.*, c.name AS category_name, c.slug AS category_slug
       FROM products p LEFT JOIN categories c ON c.id = p.category_id
       WHERE p.is_active = 1 AND p.featured = 1 AND p.stock > 0
       ORDER BY p.created_at DESC LIMIT ?`,
      [limit]
    );
    res.json(fallback.map((r) => applyProductVisibility(r, req.user)));
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Failed to fetch featured products' });
  }
}

async function getFeaturedCategoriesRanked(req, res) {
  try {
    const [rows] = await pool.query(
      `SELECT c.*, COALESCE(SUM(oi.quantity), 0) AS total_sold
       FROM categories c
       LEFT JOIN products p ON p.category_id = c.id
       LEFT JOIN order_items oi ON oi.product_id = p.id
       LEFT JOIN orders o ON o.id = oi.order_id AND o.status = 'successful'
       WHERE c.is_active = 1
       GROUP BY c.id
       ORDER BY total_sold DESC, c.name ASC`
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Failed to fetch featured categories' });
  }
}

async function getBestSelling(req, res) {
  try {
    const limit = Number(req.query.limit) || 5;
    const rows = await queryTopProducts(null, limit, true);
    if (rows.length > 0) return res.json(rows.map((r) => applyProductVisibility(r, req.user)));

    const [fallback] = await pool.query(
      `SELECT p.*, c.name AS category_name, c.slug AS category_slug
       FROM products p LEFT JOIN categories c ON c.id = p.category_id
       WHERE p.is_active = 1 AND p.stock > 0
       ORDER BY p.created_at DESC LIMIT ?`,
      [limit]
    );
    res.json(fallback.map((r) => applyProductVisibility(r, req.user)));
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Failed to fetch best selling products' });
  }
}

async function getDashboardStats(req, res) {
  try {
    // Retail (Customer) orders only - seller/wholesale orders are reported
    // separately in getSellerSalesStats so the two price ranges never mix.
    const [[{ revenue }]] = await pool.query(
      `SELECT COALESCE(SUM(total_amount), 0) AS revenue FROM orders WHERE status = 'successful' AND customer_id IS NOT NULL`
    );
    const [[{ orderCount }]] = await pool.query(`SELECT COUNT(*) AS orderCount FROM orders WHERE customer_id IS NOT NULL`);
    const [[{ productCount }]] = await pool.query(`SELECT COUNT(*) AS productCount FROM products WHERE is_active = 1`);
    const [[{ customerCount }]] = await pool.query(`SELECT COUNT(*) AS customerCount FROM customers`);

    const [revenueByDay] = await pool.query(
      `SELECT DATE(created_at) AS day, COALESCE(SUM(total_amount), 0) AS revenue
       FROM orders
       WHERE status = 'successful' AND customer_id IS NOT NULL AND created_at >= NOW() - INTERVAL 30 DAY
       GROUP BY DATE(created_at)
       ORDER BY day ASC`
    );

    const [statusBreakdown] = await pool.query(
      `SELECT status, COUNT(*) AS count FROM orders WHERE customer_id IS NOT NULL GROUP BY status`
    );

    const [topProducts] = await pool.query(
      `SELECT p.*, c.name AS category_name, c.slug AS category_slug, COALESCE(SUM(oi.quantity), 0) AS total_sold
       FROM products p
       JOIN order_items oi ON oi.product_id = p.id
       JOIN orders o ON o.id = oi.order_id
       LEFT JOIN categories c ON c.id = p.category_id
       WHERE p.is_active = 1 AND o.status = 'successful' AND o.customer_id IS NOT NULL
       GROUP BY p.id
       ORDER BY total_sold DESC
       LIMIT 10`
    );

    const [topCategories] = await pool.query(
      `SELECT c.id, c.name, COALESCE(SUM(co.quantity), 0) AS total_sold
       FROM categories c
       LEFT JOIN products p ON p.category_id = c.id
       LEFT JOIN (
         SELECT oi.product_id, oi.quantity
         FROM order_items oi
         JOIN orders o ON o.id = oi.order_id
         WHERE o.status = 'successful' AND o.customer_id IS NOT NULL
       ) co ON co.product_id = p.id
       WHERE c.is_active = 1
       GROUP BY c.id
       ORDER BY total_sold DESC, c.name ASC
       LIMIT 5`
    );

    const [topSubcategories] = await pool.query(
      `SELECT sc.id, sc.name, COALESCE(SUM(co.quantity), 0) AS total_sold
       FROM subcategories sc
       LEFT JOIN products p ON p.subcategory_id = sc.id
       LEFT JOIN (
         SELECT oi.product_id, oi.quantity
         FROM order_items oi
         JOIN orders o ON o.id = oi.order_id
         WHERE o.status = 'successful' AND o.customer_id IS NOT NULL
       ) co ON co.product_id = p.id
       WHERE sc.is_active = 1
       GROUP BY sc.id
       ORDER BY total_sold DESC, sc.name ASC
       LIMIT 5`
    );

    const [recentOrders] = await pool.query(
      `SELECT o.id, o.total_amount, o.status, o.created_at, c.name AS customer_name
       FROM orders o
       JOIN customers c ON c.id = o.customer_id
       ORDER BY o.created_at DESC
       LIMIT 10`
    );

    res.json({
      revenue: Number(revenue),
      orderCount,
      productCount,
      customerCount,
      revenueByDay,
      statusBreakdown,
      topProducts: topProducts.map((r) => applyProductVisibility(r, req.user)),
      topCategories,
      topSubcategories,
      recentOrders,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Failed to fetch dashboard stats' });
  }
}

// Orders placed by an approved Seller (wholesale/cost pricing) - join through
// users/user_roles since orders don't store a price-mode column directly.
const SELLER_ORDER_JOIN = `JOIN users su ON su.id = o.user_id JOIN user_roles sr ON sr.id = su.role_id AND sr.name = 'Seller'`;

async function getSellerSalesStats(req, res) {
  try {
    const [[{ totalCost }]] = await pool.query(
      `SELECT COALESCE(SUM(oi.quantity * p.purchase_price), 0) AS totalCost
       FROM order_items oi
       JOIN orders o ON o.id = oi.order_id
       JOIN products p ON p.id = oi.product_id
       ${SELLER_ORDER_JOIN}
       WHERE o.status = 'successful'`
    );
    const [[{ unitsSold }]] = await pool.query(
      `SELECT COALESCE(SUM(oi.quantity), 0) AS unitsSold
       FROM order_items oi
       JOIN orders o ON o.id = oi.order_id
       ${SELLER_ORDER_JOIN}
       WHERE o.status = 'successful'`
    );
    const [[{ orderCount }]] = await pool.query(
      `SELECT COUNT(*) AS orderCount FROM orders o ${SELLER_ORDER_JOIN} WHERE o.status = 'successful'`
    );
    const [[{ productCount }]] = await pool.query(
      `SELECT COUNT(*) AS productCount FROM products WHERE is_active = 1`
    );

    const [costByDay] = await pool.query(
      `SELECT DATE(o.created_at) AS day, COALESCE(SUM(oi.quantity * p.purchase_price), 0) AS cost
       FROM order_items oi
       JOIN orders o ON o.id = oi.order_id
       JOIN products p ON p.id = oi.product_id
       ${SELLER_ORDER_JOIN}
       WHERE o.status = 'successful' AND o.created_at >= NOW() - INTERVAL 30 DAY
       GROUP BY DATE(o.created_at)
       ORDER BY day ASC`
    );

    const [topProducts] = await pool.query(
      `SELECT p.id, p.name, p.product_code, p.purchase_price, c.name AS category_name,
              COALESCE(SUM(oi.quantity), 0) AS total_sold,
              COALESCE(SUM(oi.quantity * p.purchase_price), 0) AS total_cost
       FROM products p
       JOIN order_items oi ON oi.product_id = p.id
       JOIN orders o ON o.id = oi.order_id
       ${SELLER_ORDER_JOIN}
       LEFT JOIN categories c ON c.id = p.category_id
       WHERE p.is_active = 1 AND o.status = 'successful'
       GROUP BY p.id
       ORDER BY total_sold DESC
       LIMIT 10`
    );

    const [statusBreakdown] = await pool.query(
      `SELECT o.status, COUNT(*) AS count FROM orders o ${SELLER_ORDER_JOIN} GROUP BY o.status`
    );

    res.json({
      totalCost: Number(totalCost),
      unitsSold,
      orderCount,
      productCount,
      costByDay,
      topProducts,
      statusBreakdown,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Failed to fetch seller sales analysis' });
  }
}

module.exports = {
  getHotCategories,
  getHotSubcategories,
  getFeaturedProducts,
  getFeaturedCategoriesRanked,
  getBestSelling,
  getDashboardStats,
  getSellerSalesStats,
};
