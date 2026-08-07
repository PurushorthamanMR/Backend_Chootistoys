const pool = require('../config/db');
const { isValidWholesaleToken } = require('../utils/wholesaleToken');

// Public, token-gated product list for the wholesale share link - deliberately
// selects only the fields the link is meant to show (name/image/cost price),
// never sale_price/discount, and requires no login since the link itself is
// the credential (see settingsController's wholesale-token endpoints).
async function listWholesaleProducts(req, res) {
  try {
    const { token, category, subcategory, search } = req.query;
    if (!(await isValidWholesaleToken(token))) {
      return res.status(403).json({ message: 'Invalid or expired link' });
    }

    const where = ['p.is_active = 1'];
    const values = [];
    if (category) {
      where.push('c.slug = ?');
      values.push(category);
    }
    if (subcategory) {
      where.push('sc.slug = ?');
      values.push(subcategory);
    }
    if (search) {
      where.push('(p.name LIKE ? OR p.product_code LIKE ? OR c.name LIKE ? OR sc.name LIKE ?)');
      values.push(`%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`);
    }

    const [rows] = await pool.query(
      `SELECT p.id, p.slug, p.name, p.product_code, p.purchase_price, p.image, p.stock,
              c.name AS category_name, c.slug AS category_slug,
              sc.name AS subcategory_name, sc.slug AS subcategory_slug
       FROM products p
       LEFT JOIN categories c ON c.id = p.category_id
       LEFT JOIN subcategories sc ON sc.id = p.subcategory_id
       WHERE ${where.join(' AND ')}
       ORDER BY p.created_at DESC`,
      values
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Failed to fetch wholesale products' });
  }
}

module.exports = { listWholesaleProducts };
