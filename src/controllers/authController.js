const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const pool = require('../config/db');

function getSuperAdminCredentials() {
  return {
    username: process.env.SUPERADMIN_USERNAME || 'Prusoth26',
    password: process.env.SUPERADMIN_PASSWORD || 'Pruso2002',
  };
}

/** Env-only login scoped to the Point of Sale admin settings tab - no DB
 *  row, since nothing in the app needs to FK to this identity. */
function getPosSettingsCredentials() {
  return {
    username: process.env.POS_USERNAME,
    password: process.env.POS_PASSWORD,
  };
}

/** Ensure SuperAdmin exists in users so orders.user_id FK succeeds. */
async function ensureSuperAdminUser() {
  const { username, password } = getSuperAdminCredentials();
  const [[role]] = await pool.query('SELECT id FROM user_roles WHERE name = ?', ['SuperAdmin']);
  if (!role) {
    throw new Error('SuperAdmin role is not configured');
  }

  const [existing] = await pool.query(
    `SELECT u.id, u.name, u.email, u.phone, r.name AS role
     FROM users u JOIN user_roles r ON r.id = u.role_id
     WHERE u.email = ? OR r.name = 'SuperAdmin'
     ORDER BY CASE WHEN u.email = ? THEN 0 ELSE 1 END
     LIMIT 1`,
    [username, username]
  );

  if (existing.length > 0) {
    const row = existing[0];
    const hashed = await bcrypt.hash(password, 10);
    await pool.query(
      `UPDATE users SET name = ?, email = ?, password = ?, role_id = ?, status = 'approved', is_active = 1 WHERE id = ?`,
      ['Super Admin', username, hashed, role.id, row.id]
    );
    return {
      id: row.id,
      name: 'Super Admin',
      email: username,
      role: 'SuperAdmin',
      type: 'staff',
    };
  }

  const hashed = await bcrypt.hash(password, 10);
  const [result] = await pool.query(
    'INSERT INTO users (name, email, password, role_id, status, is_active) VALUES (?, ?, ?, ?, ?, ?)',
    ['Super Admin', username, hashed, role.id, 'approved', 1]
  );
  return {
    id: result.insertId,
    name: 'Super Admin',
    email: username,
    role: 'SuperAdmin',
    type: 'staff',
  };
}

function signToken(user) {
  return jwt.sign(
    { id: user.id, name: user.name, email: user.email, role: user.role, type: user.type },
    process.env.JWT_SECRET,
    { expiresIn: '7d' }
  );
}

async function login(req, res) {
  try {
    const { identifier, email, password } = req.body;
    const loginId = identifier || email;
    if (!loginId || !password) {
      return res.status(400).json({ message: 'Login identifier and password are required' });
    }

    const { username: superAdminUsername, password: superAdminPassword } = getSuperAdminCredentials();
    if (loginId === superAdminUsername && password === superAdminPassword) {
      try {
        const user = await ensureSuperAdminUser();
        return res.json({ token: signToken(user), user });
      } catch (dbErr) {
        console.error('[auth] SuperAdmin DB sync failed, falling back to env-only login:', dbErr.message);
        const user = {
          id: 0,
          name: 'Super Admin',
          email: superAdminUsername,
          role: 'SuperAdmin',
          type: 'staff',
        };
        return res.json({ token: signToken(user), user });
      }
    }

    const { username: posUsername, password: posPassword } = getPosSettingsCredentials();
    if (posUsername && posPassword && loginId === posUsername && password === posPassword) {
      const user = {
        id: -1,
        name: 'Point of Sale Settings',
        email: posUsername,
        role: 'PosSettings',
        type: 'staff',
      };
      return res.json({ token: signToken(user), user });
    }

    const [staffRows] = await pool.query(
      `SELECT u.*, r.name AS role FROM users u JOIN user_roles r ON r.id = u.role_id WHERE u.email = ? OR u.phone = ?`,
      [loginId, loginId]
    );
    if (staffRows.length > 0) {
      const dbUser = staffRows[0];
      const match = await bcrypt.compare(password, dbUser.password);
      if (!match) {
        return res.status(401).json({ message: 'Invalid credentials' });
      }
      if (dbUser.status === 'pending') {
        return res.status(403).json({ message: 'Your seller application is pending approval by the admin.' });
      }
      if (dbUser.status === 'rejected') {
        return res.status(403).json({ message: 'Your seller application was rejected. Please contact the admin.' });
      }
      if (!dbUser.is_active) {
        return res.status(403).json({ message: 'Your account has been deactivated. Please contact the admin.' });
      }
      // Staff accounts exist only to run the POS - if it's switched off there's
      // nothing for them to do, so block the login itself rather than letting
      // them in to a dead-end "POS is disabled" screen.
      if (dbUser.role === 'Staff') {
        const [[settingsRow]] = await pool.query('SELECT pos_is_active FROM settings WHERE id = 1');
        if (!settingsRow?.pos_is_active) {
          return res.status(403).json({ message: 'POS is currently disabled. Contact the store admin.' });
        }
      }
      const user = {
        id: dbUser.id,
        name: dbUser.name,
        email: dbUser.email,
        role: dbUser.role,
        phone: dbUser.phone,
        image: dbUser.image,
        type: 'staff',
      };
      const token = signToken(user);
      return res.json({ token, user });
    }

    const [customerRows] = await pool.query('SELECT * FROM customers WHERE whatsapp_number = ?', [loginId]);
    if (customerRows.length > 0) {
      const dbCustomer = customerRows[0];
      const match = await bcrypt.compare(password, dbCustomer.password);
      if (!match) {
        return res.status(401).json({ message: 'Invalid credentials' });
      }
      if (!dbCustomer.is_active) {
        return res.status(403).json({ message: 'Your account has been deactivated. Please contact the admin.' });
      }
      const user = {
        id: dbCustomer.id,
        name: dbCustomer.name,
        email: dbCustomer.email,
        phone: dbCustomer.whatsapp_number,
        image: dbCustomer.image,
        role: 'Customer',
        type: 'customer',
      };
      const token = signToken(user);
      return res.json({ token, user });
    }

    return res.status(401).json({ message: 'Invalid credentials' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Login failed' });
  }
}

async function me(req, res) {
  try {
    if (req.user.type === 'staff' && req.user.role === 'SuperAdmin' && req.user.id === 0) {
      const user = await ensureSuperAdminUser();
      return res.json(user);
    }
    if (req.user.type === 'staff' && req.user.role === 'PosSettings') {
      const { username } = getPosSettingsCredentials();
      return res.json({ id: -1, name: 'Point of Sale Settings', email: username, role: 'PosSettings', type: 'staff' });
    }
    if (req.user.type === 'customer') {
      const [rows] = await pool.query(
        'SELECT id, name, email, whatsapp_number AS phone, image FROM customers WHERE id = ?',
        [req.user.id]
      );
      if (rows.length === 0) return res.status(404).json({ message: 'Account not found' });
      return res.json({ ...rows[0], role: 'Customer', type: 'customer' });
    }

    const [rows] = await pool.query(
      `SELECT u.id, u.name, u.email, u.phone, u.address, u.shop_name, u.city, u.image, r.name AS role
       FROM users u JOIN user_roles r ON r.id = u.role_id WHERE u.id = ?`,
      [req.user.id]
    );
    if (rows.length === 0) return res.status(404).json({ message: 'User not found' });
    res.json({ ...rows[0], type: 'staff' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Failed to fetch profile' });
  }
}

async function updateProfile(req, res) {
  try {
    if (req.user.role === 'SuperAdmin') {
      return res.status(400).json({ message: 'Profile editing is not available for the SuperAdmin account' });
    }

    // Email is deliberately not editable here - changing it goes through the
    // OTP-verified /auth/change-email/* endpoints instead, so an updated
    // email can never be persisted without proving control of it.
    const { name, phone, address, shop_name, city, image, password } = req.body;
    const hashed = password ? await bcrypt.hash(password, 10) : null;

    if (req.user.type === 'customer') {
      const fields = [];
      const values = [];
      if (name !== undefined) { fields.push('name = ?'); values.push(name); }
      if (phone !== undefined) { fields.push('whatsapp_number = ?'); values.push(phone); }
      if (image !== undefined) { fields.push('image = ?'); values.push(image || null); }
      if (hashed) { fields.push('password = ?'); values.push(hashed); }
      if (fields.length === 0) return res.status(400).json({ message: 'Nothing to update' });
      values.push(req.user.id);
      await pool.query(`UPDATE customers SET ${fields.join(', ')} WHERE id = ?`, values);
      return res.json({ message: 'Profile updated' });
    }

    const fields = [];
    const values = [];
    if (name !== undefined) { fields.push('name = ?'); values.push(name); }
    if (phone !== undefined) { fields.push('phone = ?'); values.push(phone || null); }
    if (address !== undefined) { fields.push('address = ?'); values.push(address || null); }
    if (shop_name !== undefined) { fields.push('shop_name = ?'); values.push(shop_name || null); }
    if (city !== undefined) { fields.push('city = ?'); values.push(city || null); }
    if (image !== undefined) { fields.push('image = ?'); values.push(image || null); }
    if (hashed) { fields.push('password = ?'); values.push(hashed); }
    if (fields.length === 0) return res.status(400).json({ message: 'Nothing to update' });
    values.push(req.user.id);
    await pool.query(`UPDATE users SET ${fields.join(', ')} WHERE id = ?`, values);
    res.json({ message: 'Profile updated' });
  } catch (err) {
    console.error(err);
    if (err.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ message: 'That email or WhatsApp number is already in use' });
    }
    res.status(500).json({ message: 'Failed to update profile' });
  }
}

module.exports = { login, me, updateProfile, signToken };
