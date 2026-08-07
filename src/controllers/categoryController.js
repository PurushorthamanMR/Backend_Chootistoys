const pool = require('../config/db');

function slugify(text) {
  return text
    .toString()
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)+/g, '');
}

function canManage(user) {
  return user && ['Admin', 'SuperAdmin'].includes(user.role);
}

async function checkCategoryName(req, res) {
  try {
    const { name, excludeId } = req.query;
    if (!name || !name.trim()) return res.json({ available: true });
    const params = [name.trim()];
    let sql = 'SELECT id FROM categories WHERE LOWER(name) = LOWER(?)';
    if (excludeId) {
      sql += ' AND id != ?';
      params.push(excludeId);
    }
    const [rows] = await pool.query(sql, params);
    res.json({ available: rows.length === 0 });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Failed to check category name' });
  }
}

async function nameInUse(name, excludeId) {
  const params = [name.trim()];
  let sql = 'SELECT id FROM categories WHERE LOWER(name) = LOWER(?)';
  if (excludeId) {
    sql += ' AND id != ?';
    params.push(excludeId);
  }
  const [rows] = await pool.query(sql, params);
  return rows.length > 0;
}

async function listCategories(req, res) {
  try {
    const { active } = req.query;
    let isActive = 1;
    if (canManage(req.user) && active !== undefined) {
      isActive = active === '0' || active === 'false' ? 0 : 1;
    }
    const [rows] = await pool.query('SELECT * FROM categories WHERE is_active = ? ORDER BY name ASC', [isActive]);
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Failed to fetch categories' });
  }
}

async function createCategory(req, res) {
  try {
    const { name, image } = req.body;
    if (!name) return res.status(400).json({ message: 'Name is required' });
    if (await nameInUse(name)) {
      return res.status(409).json({ message: 'A category with this name already exists' });
    }
    const slug = slugify(name);
    const [result] = await pool.query(
      'INSERT INTO categories (name, slug, image) VALUES (?, ?, ?)',
      [name, slug, image || null]
    );
    res.status(201).json({ id: result.insertId, name, slug, image: image || null });
  } catch (err) {
    console.error(err);
    if (err.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ message: 'A category with this name already exists' });
    }
    res.status(500).json({ message: 'Failed to create category' });
  }
}

async function updateCategory(req, res) {
  try {
    const { id } = req.params;
    const { name, image } = req.body;
    if (name && (await nameInUse(name, id))) {
      return res.status(409).json({ message: 'A category with this name already exists' });
    }
    const slug = name ? slugify(name) : undefined;
    const fields = [];
    const values = [];
    if (name) { fields.push('name = ?'); values.push(name); }
    if (slug) { fields.push('slug = ?'); values.push(slug); }
    if (image !== undefined) { fields.push('image = ?'); values.push(image); }
    if (fields.length === 0) return res.status(400).json({ message: 'Nothing to update' });
    values.push(id);
    await pool.query(`UPDATE categories SET ${fields.join(', ')} WHERE id = ?`, values);
    res.json({ message: 'Category updated' });
  } catch (err) {
    console.error(err);
    if (err.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ message: 'A category with this name already exists' });
    }
    res.status(500).json({ message: 'Failed to update category' });
  }
}

async function deleteCategory(req, res) {
  try {
    const { id } = req.params;
    await pool.query('UPDATE categories SET is_active = 0 WHERE id = ?', [id]);
    res.json({ message: 'Category deactivated' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Failed to deactivate category' });
  }
}

async function restoreCategory(req, res) {
  try {
    const { id } = req.params;
    await pool.query('UPDATE categories SET is_active = 1 WHERE id = ?', [id]);
    res.json({ message: 'Category restored' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Failed to restore category' });
  }
}

module.exports = { listCategories, createCategory, updateCategory, deleteCategory, restoreCategory, slugify, checkCategoryName };
