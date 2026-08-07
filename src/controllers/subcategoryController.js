const pool = require('../config/db');
const { slugify } = require('./categoryController');

function canManage(user) {
  return user && ['Admin', 'SuperAdmin'].includes(user.role);
}

async function checkSubcategoryName(req, res) {
  try {
    const { name, excludeId } = req.query;
    if (!name || !name.trim()) return res.json({ available: true });
    const params = [name.trim()];
    let sql = 'SELECT id FROM subcategories WHERE LOWER(name) = LOWER(?)';
    if (excludeId) {
      sql += ' AND id != ?';
      params.push(excludeId);
    }
    const [rows] = await pool.query(sql, params);
    res.json({ available: rows.length === 0 });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Failed to check subcategory name' });
  }
}

async function nameInUse(name, excludeId) {
  const params = [name.trim()];
  let sql = 'SELECT id FROM subcategories WHERE LOWER(name) = LOWER(?)';
  if (excludeId) {
    sql += ' AND id != ?';
    params.push(excludeId);
  }
  const [rows] = await pool.query(sql, params);
  return rows.length > 0;
}

const BASE_SELECT = `
  SELECT sc.*, c.name AS category_name, c.slug AS category_slug
  FROM subcategories sc
  JOIN categories c ON c.id = sc.category_id
`;

async function listSubcategories(req, res) {
  try {
    const { active, category } = req.query;
    let isActive = 1;
    if (canManage(req.user) && active !== undefined) {
      isActive = active === '0' || active === 'false' ? 0 : 1;
    }
    const where = ['sc.is_active = ?'];
    const values = [isActive];
    if (category) {
      where.push('c.slug = ?');
      values.push(category);
    }
    const sql = `${BASE_SELECT} WHERE ${where.join(' AND ')} ORDER BY sc.name ASC`;
    const [rows] = await pool.query(sql, values);
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Failed to fetch subcategories' });
  }
}

async function createSubcategory(req, res) {
  try {
    const { name, image, category_id } = req.body;
    if (!name || !category_id) {
      return res.status(400).json({ message: 'Name and category are required' });
    }
    const [[category]] = await pool.query('SELECT id FROM categories WHERE id = ?', [category_id]);
    if (!category) {
      return res.status(400).json({ message: 'Selected category does not exist' });
    }
    if (await nameInUse(name)) {
      return res.status(409).json({ message: 'A subcategory with this name already exists' });
    }
    const slug = slugify(name);
    const [result] = await pool.query(
      'INSERT INTO subcategories (category_id, name, slug, image) VALUES (?, ?, ?, ?)',
      [category_id, name, slug, image || null]
    );
    res.status(201).json({ id: result.insertId, category_id, name, slug, image: image || null });
  } catch (err) {
    console.error(err);
    if (err.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ message: 'A subcategory with this name already exists' });
    }
    res.status(500).json({ message: 'Failed to create subcategory' });
  }
}

async function updateSubcategory(req, res) {
  try {
    const { id } = req.params;
    const { name, image, category_id } = req.body;
    if (category_id) {
      const [[category]] = await pool.query('SELECT id FROM categories WHERE id = ?', [category_id]);
      if (!category) {
        return res.status(400).json({ message: 'Selected category does not exist' });
      }
    }
    if (name && (await nameInUse(name, id))) {
      return res.status(409).json({ message: 'A subcategory with this name already exists' });
    }
    const slug = name ? slugify(name) : undefined;
    const fields = [];
    const values = [];
    if (name) { fields.push('name = ?'); values.push(name); }
    if (slug) { fields.push('slug = ?'); values.push(slug); }
    if (image !== undefined) { fields.push('image = ?'); values.push(image); }
    if (category_id) { fields.push('category_id = ?'); values.push(category_id); }
    if (fields.length === 0) return res.status(400).json({ message: 'Nothing to update' });
    values.push(id);
    await pool.query(`UPDATE subcategories SET ${fields.join(', ')} WHERE id = ?`, values);
    res.json({ message: 'Subcategory updated' });
  } catch (err) {
    console.error(err);
    if (err.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ message: 'A subcategory with this name already exists' });
    }
    res.status(500).json({ message: 'Failed to update subcategory' });
  }
}

async function deleteSubcategory(req, res) {
  try {
    const { id } = req.params;
    await pool.query('UPDATE subcategories SET is_active = 0 WHERE id = ?', [id]);
    res.json({ message: 'Subcategory deactivated' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Failed to deactivate subcategory' });
  }
}

async function restoreSubcategory(req, res) {
  try {
    const { id } = req.params;
    await pool.query('UPDATE subcategories SET is_active = 1 WHERE id = ?', [id]);
    res.json({ message: 'Subcategory restored' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Failed to restore subcategory' });
  }
}

module.exports = {
  listSubcategories,
  createSubcategory,
  updateSubcategory,
  deleteSubcategory,
  restoreSubcategory,
  checkSubcategoryName,
};
