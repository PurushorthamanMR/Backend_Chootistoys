const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const pool = require('../config/db');
const { buildSellerApplicationMessage } = require('./whatsappController');
const { isValidEmail } = require('../utils/validators');
const { getWhatsappNumber } = require('../utils/settings');
const { signToken } = require('./authController');
const { sendOtpEmail, sendWelcomeEmail, sendSellerAppliedEmail, sendStaffCreatedEmail } = require('../services/emailService');

const OTP_TTL_MINUTES = 10;
const RESEND_COOLDOWN_SECONDS = 60;
const MAX_ATTEMPTS = 5;

class OtpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function generateCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

/** Creates (or replaces) the OTP row for identifier+purpose and emails the code. */
async function createOtp(identifier, purpose, payload) {
  const [[existing]] = await pool.query(
    'SELECT created_at FROM otp_codes WHERE identifier = ? AND purpose = ?',
    [identifier, purpose]
  );
  if (existing) {
    const ageSeconds = (Date.now() - new Date(existing.created_at).getTime()) / 1000;
    if (ageSeconds < RESEND_COOLDOWN_SECONDS) {
      throw new OtpError(429, `Please wait ${Math.ceil(RESEND_COOLDOWN_SECONDS - ageSeconds)}s before requesting another code`);
    }
  }

  const code = generateCode();
  const codeHash = await bcrypt.hash(code, 10);
  const expiresAt = new Date(Date.now() + OTP_TTL_MINUTES * 60 * 1000);

  await pool.query(
    `INSERT INTO otp_codes (identifier, purpose, code_hash, payload, attempts, expires_at, verified_at)
     VALUES (?, ?, ?, ?, 0, ?, NULL)
     ON DUPLICATE KEY UPDATE code_hash = VALUES(code_hash), payload = VALUES(payload), attempts = 0,
       expires_at = VALUES(expires_at), verified_at = NULL, created_at = CURRENT_TIMESTAMP`,
    [identifier, purpose, codeHash, payload ? JSON.stringify(payload) : null, expiresAt]
  );

  await sendOtpEmail(identifier, code, purpose);
}

/** Verifies the code for identifier+purpose, deletes the row on success, returns the stored payload. */
async function verifyOtp(identifier, purpose, code) {
  const [[row]] = await pool.query('SELECT * FROM otp_codes WHERE identifier = ? AND purpose = ?', [identifier, purpose]);
  if (!row) throw new OtpError(400, 'No verification code was requested for this address. Please request a new one.');

  if (new Date(row.expires_at).getTime() < Date.now()) {
    await pool.query('DELETE FROM otp_codes WHERE id = ?', [row.id]);
    throw new OtpError(400, 'This code has expired. Please request a new one.');
  }
  if (row.attempts >= MAX_ATTEMPTS) {
    await pool.query('DELETE FROM otp_codes WHERE id = ?', [row.id]);
    throw new OtpError(400, 'Too many incorrect attempts. Please request a new code.');
  }

  const match = await bcrypt.compare(String(code), row.code_hash);
  if (!match) {
    await pool.query('UPDATE otp_codes SET attempts = attempts + 1 WHERE id = ?', [row.id]);
    throw new OtpError(400, 'Incorrect code. Please try again.');
  }

  await pool.query('DELETE FROM otp_codes WHERE id = ?', [row.id]);
  return { payload: row.payload ? JSON.parse(row.payload) : null };
}

function handleOtpError(err, res, fallbackMessage) {
  if (err instanceof OtpError) return res.status(err.status).json({ message: err.message });
  if (err.status) return res.status(err.status).json({ message: err.message });
  console.error(err);
  return res.status(500).json({ message: fallbackMessage });
}

// ---- Customer registration ----

async function sendRegisterOtp(req, res) {
  try {
    const { full_name, whatsapp_number, email, password, image } = req.body;
    if (!full_name || !whatsapp_number || !email || !password) {
      return res.status(400).json({ message: 'Full name, WhatsApp number, email and password are required' });
    }
    if (!isValidEmail(email)) {
      return res.status(400).json({ message: 'Enter a valid email address' });
    }

    const [existingPhone] = await pool.query(
      'SELECT id FROM customers WHERE whatsapp_number = ? UNION SELECT id FROM users WHERE phone = ?',
      [whatsapp_number, whatsapp_number]
    );
    if (existingPhone.length > 0) {
      return res.status(409).json({ message: 'An account with this WhatsApp number already exists' });
    }
    const [existingEmail] = await pool.query(
      'SELECT id FROM customers WHERE email = ? UNION SELECT id FROM users WHERE email = ?',
      [email, email]
    );
    if (existingEmail.length > 0) {
      return res.status(409).json({ message: 'An account with this email already exists' });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    await createOtp(email, 'register_customer', {
      full_name, whatsapp_number, email, image: image || null, password: hashedPassword,
    });
    res.json({ message: 'Verification code sent to your email', identifier: email });
  } catch (err) {
    handleOtpError(err, res, 'Failed to send verification code');
  }
}

async function verifyRegisterOtp(req, res) {
  try {
    const { email, code } = req.body;
    if (!email || !code) return res.status(400).json({ message: 'Email and code are required' });

    const { payload } = await verifyOtp(email, 'register_customer', code);
    if (!payload) return res.status(400).json({ message: 'Verification session expired. Please register again.' });

    const [existingPhone] = await pool.query(
      'SELECT id FROM customers WHERE whatsapp_number = ? UNION SELECT id FROM users WHERE phone = ?',
      [payload.whatsapp_number, payload.whatsapp_number]
    );
    if (existingPhone.length > 0) {
      return res.status(409).json({ message: 'An account with this WhatsApp number already exists' });
    }
    const [existingEmail] = await pool.query(
      'SELECT id FROM customers WHERE email = ? UNION SELECT id FROM users WHERE email = ?',
      [payload.email, payload.email]
    );
    if (existingEmail.length > 0) {
      return res.status(409).json({ message: 'An account with this email already exists' });
    }

    const [result] = await pool.query(
      'INSERT INTO customers (name, whatsapp_number, email, image, password) VALUES (?, ?, ?, ?, ?)',
      [payload.full_name, payload.whatsapp_number, payload.email, payload.image, payload.password]
    );

    const user = {
      id: result.insertId,
      name: payload.full_name,
      email: payload.email,
      phone: payload.whatsapp_number,
      image: payload.image,
      role: 'Customer',
      type: 'customer',
    };
    const token = signToken(user);
    await sendWelcomeEmail(payload.email, payload.full_name);
    res.status(201).json({ token, user });
  } catch (err) {
    handleOtpError(err, res, 'Verification failed');
  }
}

// ---- Seller application ----

async function sendSellerOtp(req, res) {
  try {
    const { full_name, email, mobile, password, shop_name, city, image } = req.body;
    if (!full_name || !email || !mobile || !password || !shop_name || !city) {
      return res.status(400).json({ message: 'Full name, email, mobile, password, shop name and city are required' });
    }
    if (!isValidEmail(email)) {
      return res.status(400).json({ message: 'Enter a valid email address' });
    }

    const [existing] = await pool.query(
      'SELECT id FROM users WHERE email = ? UNION SELECT id FROM customers WHERE email = ?',
      [email, email]
    );
    if (existing.length > 0) {
      return res.status(409).json({ message: 'An account with this email already exists' });
    }
    const [existingPhone] = await pool.query(
      'SELECT id FROM users WHERE phone = ? UNION SELECT id FROM customers WHERE whatsapp_number = ?',
      [mobile, mobile]
    );
    if (existingPhone.length > 0) {
      return res.status(409).json({ message: 'An account with this mobile number already exists' });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    await createOtp(email, 'register_seller', {
      full_name, email, mobile, shop_name, city, image: image || null, password: hashedPassword,
    });
    res.json({ message: 'Verification code sent to your email', identifier: email });
  } catch (err) {
    handleOtpError(err, res, 'Failed to send verification code');
  }
}

async function verifySellerOtp(req, res) {
  try {
    const { email, code } = req.body;
    if (!email || !code) return res.status(400).json({ message: 'Email and code are required' });

    const { payload } = await verifyOtp(email, 'register_seller', code);
    if (!payload) return res.status(400).json({ message: 'Verification session expired. Please apply again.' });

    const [existing] = await pool.query(
      'SELECT id FROM users WHERE email = ? UNION SELECT id FROM customers WHERE email = ?',
      [payload.email, payload.email]
    );
    if (existing.length > 0) {
      return res.status(409).json({ message: 'An account with this email already exists' });
    }
    const [existingPhone] = await pool.query(
      'SELECT id FROM users WHERE phone = ? UNION SELECT id FROM customers WHERE whatsapp_number = ?',
      [payload.mobile, payload.mobile]
    );
    if (existingPhone.length > 0) {
      return res.status(409).json({ message: 'An account with this mobile number already exists' });
    }

    const [[sellerRole]] = await pool.query('SELECT id FROM user_roles WHERE name = ?', ['Seller']);
    if (!sellerRole) {
      return res.status(500).json({ message: 'Seller role is not configured' });
    }

    await pool.query(
      'INSERT INTO users (name, email, password, phone, shop_name, city, image, role_id, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [payload.full_name, payload.email, payload.password, payload.mobile, payload.shop_name, payload.city, payload.image, sellerRole.id, 'pending']
    );

    await sendSellerAppliedEmail(payload.email, payload.full_name, payload.shop_name);

    // Same pattern as order requests: the applicant opens WhatsApp on their
    // own device with the message pre-filled, instead of a server-side bot
    // send (which is unreliable - see whatsapp service ban risk).
    const adminNumber = await getWhatsappNumber(pool);
    const message = buildSellerApplicationMessage(payload.full_name, payload.email, payload.mobile);

    res.status(201).json({
      message: 'Application sent to admin. After verification you will get a message, then you can use your Seller account.',
      whatsapp: adminNumber ? { number: adminNumber, text: message } : null,
    });
  } catch (err) {
    handleOtpError(err, res, 'Failed to submit seller application');
  }
}

// ---- Staff creation (Admin > Users > Add Staff) ----
// Admin-initiated, unlike the self-service flows above - the OTP still goes
// to the new staff member's own email (proving the admin didn't mistype it
// and that the cashier actually has access to that inbox) but it's the
// Admin who requests/enters the code, since they're driving the form.

async function sendStaffOtp(req, res) {
  try {
    const { name, email, password, phone } = req.body;
    if (!name || !email || !password) {
      return res.status(400).json({ message: 'Name, email, and password are required' });
    }
    if (!isValidEmail(email)) {
      return res.status(400).json({ message: 'Enter a valid email address' });
    }

    const [existingEmail] = await pool.query('SELECT id FROM users WHERE email = ?', [email]);
    if (existingEmail.length > 0) {
      return res.status(409).json({ message: 'That email is already in use' });
    }
    if (phone) {
      const [existingPhone] = await pool.query('SELECT id FROM users WHERE phone = ?', [phone]);
      if (existingPhone.length > 0) {
        return res.status(409).json({ message: 'That phone number is already in use' });
      }
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    await createOtp(email, 'create_staff', { name, email, phone: phone || null, password: hashedPassword });
    res.json({ message: 'Verification code sent to the staff email', identifier: email });
  } catch (err) {
    handleOtpError(err, res, 'Failed to send verification code');
  }
}

async function verifyStaffOtp(req, res) {
  try {
    const { email, code } = req.body;
    if (!email || !code) return res.status(400).json({ message: 'Email and code are required' });

    const { payload } = await verifyOtp(email, 'create_staff', code);
    if (!payload) return res.status(400).json({ message: 'Verification session expired. Please fill the form again.' });

    const [existingEmail] = await pool.query('SELECT id FROM users WHERE email = ?', [payload.email]);
    if (existingEmail.length > 0) {
      return res.status(409).json({ message: 'That email is already in use' });
    }
    if (payload.phone) {
      const [existingPhone] = await pool.query('SELECT id FROM users WHERE phone = ?', [payload.phone]);
      if (existingPhone.length > 0) {
        return res.status(409).json({ message: 'That phone number is already in use' });
      }
    }

    const [[role]] = await pool.query(`SELECT id FROM user_roles WHERE name = 'Staff'`);
    if (!role) return res.status(500).json({ message: 'Staff role is not configured' });

    const [result] = await pool.query(
      `INSERT INTO users (name, email, password, phone, role_id, status, is_active) VALUES (?, ?, ?, ?, ?, 'approved', 1)`,
      [payload.name, payload.email, payload.password, payload.phone, role.id]
    );

    await sendStaffCreatedEmail(payload.email, payload.name);

    res.status(201).json({ id: result.insertId, message: 'Staff account created' });
  } catch (err) {
    handleOtpError(err, res, 'Verification failed');
  }
}

// ---- Forgot password ----

async function sendForgotPasswordOtp(req, res) {
  try {
    const { identifier } = req.body;
    if (!identifier) return res.status(400).json({ message: 'Email or phone number is required' });

    const [staffRows] = await pool.query('SELECT email FROM users WHERE email = ? OR phone = ?', [identifier, identifier]);
    const [customerRows] = await pool.query(
      'SELECT email FROM customers WHERE whatsapp_number = ? OR email = ?',
      [identifier, identifier]
    );
    const account = staffRows[0] || customerRows[0];

    if (!account) {
      return res.status(404).json({ message: 'No account found with that email or phone number' });
    }
    if (!account.email) {
      return res
        .status(400)
        .json({ message: 'No email is on file for this account. Please contact support to reset your password.' });
    }

    await createOtp(account.email, 'forgot_password', null);
    res.json({ identifier: account.email });
  } catch (err) {
    handleOtpError(err, res, 'Failed to send verification code');
  }
}

async function verifyForgotPasswordOtp(req, res) {
  try {
    const { identifier, code } = req.body;
    if (!identifier || !code) return res.status(400).json({ message: 'Code is required' });

    await verifyOtp(identifier, 'forgot_password', code);

    const resetToken = jwt.sign({ identifier, purpose: 'password_reset' }, process.env.JWT_SECRET, { expiresIn: '10m' });
    res.json({ resetToken });
  } catch (err) {
    handleOtpError(err, res, 'Verification failed');
  }
}

async function resetPassword(req, res) {
  try {
    const { resetToken, password } = req.body;
    if (!resetToken || !password) {
      return res.status(400).json({ message: 'Reset token and new password are required' });
    }
    if (password.length < 6) {
      return res.status(400).json({ message: 'Password must be at least 6 characters' });
    }

    let payload;
    try {
      payload = jwt.verify(resetToken, process.env.JWT_SECRET);
    } catch {
      return res.status(400).json({ message: 'Reset session has expired. Please request a new code.' });
    }
    if (payload.purpose !== 'password_reset') {
      return res.status(400).json({ message: 'Invalid reset token' });
    }

    const hashed = await bcrypt.hash(password, 10);
    const [staffResult] = await pool.query('UPDATE users SET password = ? WHERE email = ?', [hashed, payload.identifier]);
    if (staffResult.affectedRows === 0) {
      await pool.query('UPDATE customers SET password = ? WHERE email = ?', [hashed, payload.identifier]);
    }

    res.json({ message: 'Password updated. You can now log in.' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Failed to reset password' });
  }
}

// ---- Change email (Profile) ----

async function sendChangeEmailOtp(req, res) {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ message: 'Email is required' });
    if (!isValidEmail(email)) return res.status(400).json({ message: 'Enter a valid email address' });

    const table = req.user.type === 'customer' ? 'customers' : 'users';
    const [existing] = await pool.query(`SELECT id FROM ${table} WHERE email = ? AND id != ?`, [email, req.user.id]);
    if (existing.length > 0) {
      return res.status(409).json({ message: 'That email is already in use' });
    }

    await createOtp(email, 'change_email', { userId: req.user.id, userType: req.user.type });
    res.json({ message: 'Verification code sent to your new email', identifier: email });
  } catch (err) {
    handleOtpError(err, res, 'Failed to send verification code');
  }
}

async function verifyChangeEmailOtp(req, res) {
  try {
    const { email, code } = req.body;
    if (!email || !code) return res.status(400).json({ message: 'Email and code are required' });

    const { payload } = await verifyOtp(email, 'change_email', code);
    if (!payload || payload.userId !== req.user.id || payload.userType !== req.user.type) {
      return res.status(400).json({ message: 'Verification session expired. Please try again.' });
    }

    const table = req.user.type === 'customer' ? 'customers' : 'users';
    const [existing] = await pool.query(`SELECT id FROM ${table} WHERE email = ? AND id != ?`, [email, req.user.id]);
    if (existing.length > 0) {
      return res.status(409).json({ message: 'That email is already in use' });
    }

    await pool.query(`UPDATE ${table} SET email = ? WHERE id = ?`, [email, req.user.id]);
    res.json({ email });
  } catch (err) {
    handleOtpError(err, res, 'Verification failed');
  }
}

module.exports = {
  sendRegisterOtp,
  verifyRegisterOtp,
  sendSellerOtp,
  verifySellerOtp,
  sendStaffOtp,
  verifyStaffOtp,
  sendForgotPasswordOtp,
  verifyForgotPasswordOtp,
  resetPassword,
  sendChangeEmailOtp,
  verifyChangeEmailOtp,
};
