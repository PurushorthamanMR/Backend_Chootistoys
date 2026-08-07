const pool = require('../config/db');

function applyFieldVisibility(row, user) {
  const role = user?.role;
  const canSeeCode = role === 'Admin' || role === 'SuperAdmin';
  const canSeeCost = canSeeCode || role === 'Seller';
  const result = { ...row };
  if (!canSeeCode) delete result.product_code;
  if (!canSeeCost) delete result.purchase_price;
  return result;
}

async function listWishlistIds(req, res) {
  try {
    const [rows] = await pool.query(
      'SELECT product_id FROM wishlist_items WHERE owner_type = ? AND owner_id = ?',
      [req.user.type, req.user.id]
    );
    res.json(rows.map((r) => r.product_id));
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Failed to fetch wishlist' });
  }
}

async function listWishlist(req, res) {
  try {
    const [rows] = await pool.query(
      `SELECT p.*, c.name AS category_name, c.slug AS category_slug
       FROM wishlist_items w
       JOIN products p ON p.id = w.product_id
       LEFT JOIN categories c ON c.id = p.category_id
       WHERE w.owner_type = ? AND w.owner_id = ?
       ORDER BY w.created_at DESC`,
      [req.user.type, req.user.id]
    );
    res.json(rows.map((row) => applyFieldVisibility(row, req.user)));
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Failed to fetch wishlist' });
  }
}

async function toggleWishlist(req, res) {
  try {
    const { productId } = req.params;
    const [existing] = await pool.query(
      'SELECT id FROM wishlist_items WHERE owner_type = ? AND owner_id = ? AND product_id = ?',
      [req.user.type, req.user.id, productId]
    );
    if (existing.length > 0) {
      await pool.query('DELETE FROM wishlist_items WHERE id = ?', [existing[0].id]);
      return res.json({ wishlisted: false });
    }
    await pool.query(
      'INSERT INTO wishlist_items (owner_type, owner_id, product_id) VALUES (?, ?, ?)',
      [req.user.type, req.user.id, productId]
    );
    res.json({ wishlisted: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Failed to update wishlist' });
  }
}

module.exports = { listWishlistIds, listWishlist, toggleWishlist };
