const pool = require('../config/db');
const { isValidEmail } = require('../utils/validators');
const { sendSellerApprovedEmail, sendSellerRejectedEmail } = require('../services/emailService');
const { ANONYMOUS_SELLER_MARKER } = require('../utils/anonymousSeller');

const ASSIGNABLE_ROLES = ['Seller', 'Admin'];

const VALID_STATUSES = ['pending', 'approved', 'rejected'];

async function checkUserField(req, res) {
  try {
    const { field, value, excludeId } = req.query;
    if (!['email', 'phone'].includes(field) || !value || !value.trim()) {
      return res.json({ available: true });
    }
    const trimmed = value.trim();

    const params = [trimmed];
    let sql = `SELECT id FROM users WHERE ${field} = ?`;
    if (excludeId) {
      sql += ' AND id != ?';
      params.push(excludeId);
    }
    const [rows] = await pool.query(sql, params);

    // Email/phone must be unique across customers too, not just other staff/sellers -
    // otherwise the same number could sit on both a customer and a seller account.
    const customerColumn = field === 'phone' ? 'whatsapp_number' : 'email';
    const [customerRows] = await pool.query(`SELECT id FROM customers WHERE ${customerColumn} = ?`, [trimmed]);

    res.json({ available: rows.length === 0 && customerRows.length === 0 });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Failed to check availability' });
  }
}

async function fieldInUse(field, value, excludeId) {
  const params = [value.trim()];
  let sql = `SELECT id FROM users WHERE ${field} = ?`;
  if (excludeId) {
    sql += ' AND id != ?';
    params.push(excludeId);
  }
  const [rows] = await pool.query(sql, params);
  return rows.length > 0;
}

async function listUsers(req, res) {
  try {
    const { status } = req.query;
    const filterStatus = VALID_STATUSES.includes(status) ? status : 'approved';
    const [rows] = await pool.query(
      `SELECT u.id, u.name, u.email, u.phone, u.shop_name, u.city, r.name AS role, u.status, u.is_active, u.created_at
       FROM users u JOIN user_roles r ON r.id = u.role_id
       WHERE u.status = ? AND r.name IN ('Admin', 'Seller') AND u.email != ?
       ORDER BY u.created_at DESC`,
      [filterStatus, ANONYMOUS_SELLER_MARKER]
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Failed to fetch users' });
  }
}

async function updateUserRole(req, res) {
  try {
    const { id } = req.params;
    const { role } = req.body;
    if (!ASSIGNABLE_ROLES.includes(role)) {
      return res.status(400).json({ message: 'Invalid role' });
    }
    const [[roleRow]] = await pool.query('SELECT id FROM user_roles WHERE name = ?', [role]);
    if (!roleRow) {
      return res.status(400).json({ message: 'Invalid role' });
    }
    await pool.query('UPDATE users SET role_id = ? WHERE id = ?', [roleRow.id, id]);
    res.json({ message: 'User role updated' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Failed to update user role' });
  }
}

async function updateUser(req, res) {
  try {
    const { id } = req.params;
    const { name, email, phone, shop_name, city } = req.body;
    if (email && !isValidEmail(email)) {
      return res.status(400).json({ message: 'Enter a valid email address' });
    }
    if (email && (await fieldInUse('email', email, id))) {
      return res.status(409).json({ message: 'That email is already in use' });
    }
    if (phone && (await fieldInUse('phone', phone, id))) {
      return res.status(409).json({ message: 'That phone number is already in use' });
    }
    const fields = [];
    const values = [];
    if (name !== undefined) { fields.push('name = ?'); values.push(name); }
    if (email !== undefined) { fields.push('email = ?'); values.push(email); }
    if (phone !== undefined) { fields.push('phone = ?'); values.push(phone || null); }
    if (shop_name !== undefined) { fields.push('shop_name = ?'); values.push(shop_name || null); }
    if (city !== undefined) { fields.push('city = ?'); values.push(city || null); }
    if (fields.length === 0) return res.status(400).json({ message: 'Nothing to update' });
    values.push(id);
    await pool.query(`UPDATE users SET ${fields.join(', ')} WHERE id = ?`, values);
    res.json({ message: 'User updated' });
  } catch (err) {
    console.error(err);
    if (err.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ message: 'That email is already in use' });
    }
    res.status(500).json({ message: 'Failed to update user' });
  }
}

async function approveUser(req, res) {
  try {
    const { id } = req.params;
    const [[user]] = await pool.query('SELECT name, email, shop_name FROM users WHERE id = ?', [id]);
    await pool.query(`UPDATE users SET status = 'approved', is_active = 1 WHERE id = ?`, [id]);
    if (user?.email) {
      await sendSellerApprovedEmail(user.email, user.name, user.shop_name);
    }
    res.json({ message: 'User approved' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Failed to approve user' });
  }
}

async function rejectUser(req, res) {
  try {
    const { id } = req.params;
    const [[user]] = await pool.query('SELECT name, email, shop_name FROM users WHERE id = ?', [id]);
    await pool.query(`UPDATE users SET status = 'rejected', is_active = 0 WHERE id = ?`, [id]);
    if (user?.email) {
      await sendSellerRejectedEmail(user.email, user.name, user.shop_name);
    }
    res.json({ message: 'User rejected' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Failed to reject user' });
  }
}

module.exports = {
  listUsers,
  updateUserRole,
  updateUser,
  approveUser,
  rejectUser,
  checkUserField,
};
