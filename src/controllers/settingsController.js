const pool = require('../config/db');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { sendSetupCompleteEmail } = require('../services/emailService');
const driveService = require('../services/driveService');

// This endpoint is public (no login required, used to theme the site for every
// visitor) so wholesale_token must never be selected here - it's fetched only
// via the admin-only endpoints below.
const PUBLIC_SETTINGS_COLUMNS = `
  id, store_name, store_short_name, store_logo, store_icon, whatsapp_number, address, email,
  theme_color_light, theme_color_dark, active_font,
  terms_content, return_policy_content, privacy_policy_content, about_content, updated_at,
  pos_is_active, pos_tax_percent, pos_service_charge_percent, pos_receipt_phone, pos_display_price,
  pos_reduce_sale_min, pos_reduce_sale_max, pos_reduce_sale_is_active
`;

// Drives the admin panel's setup-progress bar. A section counts as complete
// once every one of its columns is non-null/non-empty - Wholesale is
// deliberately excluded (not part of initial store setup).
const SETUP_SECTIONS = [
  { key: 'general', label: 'General', columns: ['store_logo', 'store_icon'] },
  { key: 'contact', label: 'Contact', columns: ['whatsapp_number', 'address', 'email'] },
  { key: 'appearance', label: 'Appearance', columns: ['theme_color_light', 'theme_color_dark', 'active_font'] },
  { key: 'legal', label: 'Legal Pages', columns: ['terms_content', 'return_policy_content', 'privacy_policy_content'] },
  {
    key: 'drive',
    label: 'Google Drive',
    columns: ['drive_client_id', 'drive_client_secret', 'drive_refresh_token', 'drive_folder_id'],
  },
  {
    key: 'email',
    label: 'Email (EmailJS)',
    columns: ['emailjs_service_id', 'emailjs_public_key', 'emailjs_private_key', 'emailjs_template_otp', 'emailjs_template_notify'],
  },
];

function isFilled(value) {
  return value !== null && value !== undefined && String(value).trim() !== '';
}

function computeSetupStatus(row) {
  const sections = SETUP_SECTIONS.map(({ key, label, columns }) => ({
    key,
    label,
    complete: columns.every((col) => isFilled(row?.[col])),
  }));
  const completedCount = sections.filter((s) => s.complete).length;
  const totalCount = sections.length;
  return { sections, completedCount, totalCount, percent: Math.round((completedCount / totalCount) * 100) };
}

async function getSetupStatus(req, res) {
  try {
    const [[row]] = await pool.query('SELECT * FROM settings WHERE id = 1');
    res.json(computeSetupStatus(row));
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Failed to fetch setup status' });
  }
}

async function getSettings(req, res) {
  try {
    const [[settings]] = await pool.query(`SELECT ${PUBLIC_SETTINGS_COLUMNS} FROM settings WHERE id = 1`);
    res.json(settings);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Failed to fetch settings' });
  }
}

// Admin-only - emailjs_private_key must never reach the public /settings endpoint.
async function getEmailSettings(req, res) {
  try {
    const [[row]] = await pool.query(
      `SELECT emailjs_service_id, emailjs_public_key, emailjs_private_key, emailjs_reply_to,
              emailjs_template_otp, emailjs_template_notify
       FROM settings WHERE id = 1`
    );
    res.json(row);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Failed to fetch email settings' });
  }
}

function driveRedirectUri() {
  const base = (process.env.BACKEND_URL || 'http://localhost:5000').replace(/\/$/, '');
  return `${base}/api/settings/drive/oauth/callback`;
}

function frontendSettingsUrl(query = '') {
  const origin = (process.env.FRONTEND_URL || 'http://localhost:5173')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean)[0] || 'http://localhost:5173';
  return `${origin.replace(/\/$/, '')}/admin/settings${query ? `?tab=drive&${query.replace(/^\?/, '')}` : '?tab=drive'}`;
}

// Admin-only - drive_client_secret / drive_refresh_token must never reach the public /settings endpoint.
async function getDriveSettings(req, res) {
  try {
    const [[row]] = await pool.query(
      `SELECT drive_client_id, drive_client_secret, drive_refresh_token, drive_folder_id
       FROM settings WHERE id = 1`
    );
    res.json({
      ...row,
      drive_connected: Boolean(row?.drive_refresh_token),
      drive_redirect_uri: driveRedirectUri(),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Failed to fetch Google Drive settings' });
  }
}

async function startDriveOAuth(req, res) {
  try {
    const [[row]] = await pool.query(
      'SELECT drive_client_id, drive_client_secret FROM settings WHERE id = 1'
    );
    if (!row?.drive_client_id || !row?.drive_client_secret) {
      return res.status(400).json({
        message: 'Save your Google OAuth Client ID and Client Secret first, then connect.',
      });
    }

    const state = jwt.sign(
      { purpose: 'drive_oauth', adminId: req.user.id },
      process.env.JWT_SECRET,
      { expiresIn: '10m' }
    );

    const url = driveService.getAuthUrl(
      {
        drive_client_id: row.drive_client_id,
        drive_client_secret: row.drive_client_secret,
        redirectUri: driveRedirectUri(),
      },
      state
    );
    res.json({ url });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Failed to start Google Drive connection' });
  }
}

async function driveOAuthCallback(req, res) {
  const fail = (reason) => {
    res.redirect(frontendSettingsUrl(`?drive=error&reason=${encodeURIComponent(reason)}`));
  };

  try {
    const { code, state, error } = req.query;
    if (error) {
      if (String(error) === 'access_denied') {
        return fail(
          'Google blocked sign-in (access_denied). Add your Gmail as a Test user under Google Cloud → OAuth consent screen, then try Connect again.'
        );
      }
      return fail(String(error));
    }
    if (!code || !state) return fail('missing_code');

    let payload;
    try {
      payload = jwt.verify(state, process.env.JWT_SECRET);
    } catch {
      return fail('invalid_state');
    }
    if (payload.purpose !== 'drive_oauth') return fail('invalid_state');

    const [[row]] = await pool.query(
      'SELECT drive_client_id, drive_client_secret FROM settings WHERE id = 1'
    );
    if (!row?.drive_client_id || !row?.drive_client_secret) {
      return fail('missing_credentials');
    }

    const refreshToken = await driveService.exchangeCode(
      {
        drive_client_id: row.drive_client_id,
        drive_client_secret: row.drive_client_secret,
        redirectUri: driveRedirectUri(),
      },
      code
    );

    const [[beforeRow]] = await pool.query('SELECT * FROM settings WHERE id = 1');
    const beforeStatus = computeSetupStatus(beforeRow);

    await pool.query('UPDATE settings SET drive_refresh_token = ? WHERE id = 1', [refreshToken]);

    const [[afterRow]] = await pool.query('SELECT * FROM settings WHERE id = 1');
    if (beforeStatus.percent < 100 && computeSetupStatus(afterRow).percent === 100) {
      await sendSetupCompleteEmail(afterRow.email);
    }

    res.redirect(frontendSettingsUrl('?drive=connected'));
  } catch (err) {
    console.error(err);
    fail(err.message || 'oauth_failed');
  }
}

async function getWholesaleToken(req, res) {
  try {
    const [[row]] = await pool.query('SELECT wholesale_token FROM settings WHERE id = 1');
    res.json({ wholesale_token: row?.wholesale_token || null });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Failed to fetch wholesale link' });
  }
}

async function regenerateWholesaleToken(req, res) {
  try {
    const token = crypto.randomBytes(24).toString('hex');
    await pool.query('UPDATE settings SET wholesale_token = ? WHERE id = 1', [token]);
    res.json({ wholesale_token: token });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Failed to regenerate wholesale link' });
  }
}

async function updateSettings(req, res) {
  try {
    const {
      store_name, store_short_name, store_logo, store_icon, whatsapp_number, address, email,
      theme_color_light, theme_color_dark,
      terms_content, return_policy_content, privacy_policy_content, about_content,
      emailjs_service_id, emailjs_public_key, emailjs_private_key, emailjs_reply_to,
      emailjs_template_otp, emailjs_template_notify,
      drive_client_id, drive_client_secret, drive_refresh_token, drive_folder_id,
      active_font,
      pos_is_active, pos_tax_percent, pos_service_charge_percent, pos_receipt_phone, pos_display_price,
      pos_reduce_sale_min, pos_reduce_sale_max, pos_reduce_sale_is_active,
    } = req.body;

    // POS on/off + its default rates are a SuperAdmin-only control (this
    // route is otherwise Admin-or-SuperAdmin) - reject outright rather than
    // silently ignore, so a non-SuperAdmin gets a clear error instead of a
    // confusing "saved but nothing changed".
    const posFieldsTouched = [
      pos_is_active,
      pos_tax_percent,
      pos_service_charge_percent,
      pos_receipt_phone,
      pos_display_price,
      pos_reduce_sale_min,
      pos_reduce_sale_max,
      pos_reduce_sale_is_active,
    ].some((v) => v !== undefined);
    if (posFieldsTouched && req.user.role !== 'SuperAdmin') {
      return res.status(403).json({ message: 'Only Super Admin can change POS settings' });
    }

    const fields = [];
    const values = [];
    if (store_name !== undefined) { fields.push('store_name = ?'); values.push(store_name); }
    if (store_short_name !== undefined) { fields.push('store_short_name = ?'); values.push(store_short_name); }
    if (store_logo !== undefined) { fields.push('store_logo = ?'); values.push(store_logo || null); }
    if (store_icon !== undefined) { fields.push('store_icon = ?'); values.push(store_icon || null); }
    if (whatsapp_number !== undefined) { fields.push('whatsapp_number = ?'); values.push(whatsapp_number || null); }
    if (address !== undefined) { fields.push('address = ?'); values.push(address || null); }
    if (email !== undefined) { fields.push('email = ?'); values.push(email || null); }
    if (theme_color_light !== undefined) { fields.push('theme_color_light = ?'); values.push(theme_color_light); }
    if (theme_color_dark !== undefined) { fields.push('theme_color_dark = ?'); values.push(theme_color_dark); }
    if (terms_content !== undefined) { fields.push('terms_content = ?'); values.push(terms_content || null); }
    if (return_policy_content !== undefined) { fields.push('return_policy_content = ?'); values.push(return_policy_content || null); }
    if (privacy_policy_content !== undefined) { fields.push('privacy_policy_content = ?'); values.push(privacy_policy_content || null); }
    if (about_content !== undefined) { fields.push('about_content = ?'); values.push(about_content || null); }
    if (emailjs_service_id !== undefined) { fields.push('emailjs_service_id = ?'); values.push(emailjs_service_id || null); }
    if (emailjs_public_key !== undefined) { fields.push('emailjs_public_key = ?'); values.push(emailjs_public_key || null); }
    if (emailjs_private_key !== undefined) { fields.push('emailjs_private_key = ?'); values.push(emailjs_private_key || null); }
    if (emailjs_reply_to !== undefined) { fields.push('emailjs_reply_to = ?'); values.push(emailjs_reply_to || null); }
    if (emailjs_template_otp !== undefined) { fields.push('emailjs_template_otp = ?'); values.push(emailjs_template_otp || null); }
    if (emailjs_template_notify !== undefined) { fields.push('emailjs_template_notify = ?'); values.push(emailjs_template_notify || null); }
    if (drive_client_id !== undefined) { fields.push('drive_client_id = ?'); values.push(drive_client_id || null); }
    if (drive_client_secret !== undefined) { fields.push('drive_client_secret = ?'); values.push(drive_client_secret || null); }
    if (drive_refresh_token !== undefined) { fields.push('drive_refresh_token = ?'); values.push(drive_refresh_token || null); }
    if (drive_folder_id !== undefined) { fields.push('drive_folder_id = ?'); values.push(drive_folder_id || null); }
    if (active_font !== undefined) { fields.push('active_font = ?'); values.push(active_font); }
    if (pos_is_active !== undefined) { fields.push('pos_is_active = ?'); values.push(pos_is_active ? 1 : 0); }
    if (pos_tax_percent !== undefined) { fields.push('pos_tax_percent = ?'); values.push(pos_tax_percent); }
    if (pos_service_charge_percent !== undefined) {
      fields.push('pos_service_charge_percent = ?');
      values.push(pos_service_charge_percent);
    }
    if (pos_receipt_phone !== undefined) { fields.push('pos_receipt_phone = ?'); values.push(pos_receipt_phone || null); }
    if (pos_display_price !== undefined) {
      const mode = String(pos_display_price).toLowerCase() === 'cost' ? 'cost' : 'sale';
      fields.push('pos_display_price = ?');
      values.push(mode);
    }
    if (pos_reduce_sale_min !== undefined || pos_reduce_sale_max !== undefined) {
      const minVal = pos_reduce_sale_min !== undefined ? Number(pos_reduce_sale_min) : null;
      const maxVal = pos_reduce_sale_max !== undefined ? Number(pos_reduce_sale_max) : null;
      if (minVal !== null && (Number.isNaN(minVal) || minVal < 0)) {
        return res.status(400).json({ message: 'Reduce Sale min must be 0 or greater' });
      }
      if (maxVal !== null && (Number.isNaN(maxVal) || maxVal < 0)) {
        return res.status(400).json({ message: 'Reduce Sale max must be 0 or greater' });
      }
      if (minVal !== null && maxVal !== null && minVal > maxVal) {
        return res.status(400).json({ message: 'Reduce Sale min cannot be greater than max' });
      }
      if (pos_reduce_sale_min !== undefined) {
        fields.push('pos_reduce_sale_min = ?');
        values.push(minVal);
      }
      if (pos_reduce_sale_max !== undefined) {
        fields.push('pos_reduce_sale_max = ?');
        values.push(maxVal);
      }
    }
    if (pos_reduce_sale_is_active !== undefined) {
      fields.push('pos_reduce_sale_is_active = ?');
      values.push(pos_reduce_sale_is_active ? 1 : 0);
    }
    if (fields.length === 0) return res.status(400).json({ message: 'Nothing to update' });

    const [[beforeRow]] = await pool.query('SELECT * FROM settings WHERE id = 1');
    const beforeStatus = computeSetupStatus(beforeRow);

    await pool.query(`UPDATE settings SET ${fields.join(', ')} WHERE id = 1`, values);

    const [[afterRow]] = await pool.query('SELECT * FROM settings WHERE id = 1');
    if (beforeStatus.percent < 100 && computeSetupStatus(afterRow).percent === 100) {
      await sendSetupCompleteEmail(afterRow.email);
    }

    const [[settings]] = await pool.query(`SELECT ${PUBLIC_SETTINGS_COLUMNS} FROM settings WHERE id = 1`);
    res.json(settings);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Failed to update settings' });
  }
}

module.exports = {
  getSettings,
  updateSettings,
  getEmailSettings,
  getDriveSettings,
  startDriveOAuth,
  driveOAuthCallback,
  getSetupStatus,
  getWholesaleToken,
  regenerateWholesaleToken,
};
