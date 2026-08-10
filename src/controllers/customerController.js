const pool = require('../config/db');
const { isValidEmail } = require('../utils/validators');
const { ANONYMOUS_WHATSAPP_MARKER } = require('../utils/anonymousCustomer');

async function checkCustomerField(req, res) {
  try {
    const { field, value, excludeId } = req.query;
    if (!['email', 'phone'].includes(field) || !value || !value.trim()) {
      return res.json({ available: true });
    }
    const trimmed = value.trim();
    const column = field === 'phone' ? 'whatsapp_number' : 'email';

    const params = [trimmed];
    let sql = `SELECT id FROM customers WHERE ${column} = ?`;
    if (excludeId) {
      sql += ' AND id != ?';
      params.push(excludeId);
    }
    const [rows] = await pool.query(sql, params);

    // Email/phone must be unique across staff/sellers too, not just other
    // customers - otherwise the same number could sit on both account types.
    const [userRows] = await pool.query(`SELECT id FROM users WHERE ${field} = ?`, [trimmed]);

    res.json({ available: rows.length === 0 && userRows.length === 0 });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Failed to check availability' });
  }
}

async function fieldInUse(column, value, excludeId) {
  const params = [value.trim()];
  let sql = `SELECT id FROM customers WHERE ${column} = ?`;
  if (excludeId) {
    sql += ' AND id != ?';
    params.push(excludeId);
  }
  const [rows] = await pool.query(sql, params);
  return rows.length > 0;
}

async function listCustomers(req, res) {
  try {
    const { active, search } = req.query;
    const isActive = active === '0' || active === 'false' ? 0 : 1;
    const where = ['is_active = ?', 'whatsapp_number != ?'];
    const params = [isActive, ANONYMOUS_WHATSAPP_MARKER];
    if (search) {
      where.push('(name LIKE ? OR whatsapp_number LIKE ?)');
      params.push(`%${search}%`, `%${search}%`);
    }
    const [rows] = await pool.query(
      `SELECT id, name, email, whatsapp_number AS phone, is_active, created_at
       FROM customers WHERE ${where.join(' AND ')} ORDER BY created_at DESC`,
      params
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Failed to fetch customers' });
  }
}

async function updateCustomer(req, res) {
  try {
    const { id } = req.params;
    const { name, email, phone } = req.body;
    if (email && !isValidEmail(email)) {
      return res.status(400).json({ message: 'Enter a valid email address' });
    }
    if (email && (await fieldInUse('email', email, id))) {
      return res.status(409).json({ message: 'That email is already in use' });
    }
    if (phone && (await fieldInUse('whatsapp_number', phone, id))) {
      return res.status(409).json({ message: 'That WhatsApp number is already in use' });
    }
    const fields = [];
    const values = [];
    if (name !== undefined) { fields.push('name = ?'); values.push(name); }
    if (email !== undefined) { fields.push('email = ?'); values.push(email || null); }
    if (phone !== undefined) { fields.push('whatsapp_number = ?'); values.push(phone); }
    if (fields.length === 0) return res.status(400).json({ message: 'Nothing to update' });
    values.push(id);
    await pool.query(`UPDATE customers SET ${fields.join(', ')} WHERE id = ?`, values);
    res.json({ message: 'Customer updated' });
  } catch (err) {
    console.error(err);
    if (err.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ message: 'That WhatsApp number is already in use' });
    }
    res.status(500).json({ message: 'Failed to update customer' });
  }
}

async function deactivateCustomer(req, res) {
  try {
    const { id } = req.params;
    await pool.query('UPDATE customers SET is_active = 0 WHERE id = ?', [id]);
    res.json({ message: 'Customer deactivated' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Failed to deactivate customer' });
  }
}

async function restoreCustomer(req, res) {
  try {
    const { id } = req.params;
    await pool.query('UPDATE customers SET is_active = 1 WHERE id = ?', [id]);
    res.json({ message: 'Customer restored' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Failed to restore customer' });
  }
}

module.exports = { listCustomers, updateCustomer, deactivateCustomer, restoreCustomer, checkCustomerField };
