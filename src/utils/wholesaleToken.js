const pool = require('../config/db');

/** Shared by the wholesale product list and the wholesale order-request flow
 *  so both gate on the exact same secret (see settingsController's
 *  wholesale-token endpoints for how it's generated/regenerated). */
async function isValidWholesaleToken(token) {
  if (!token) return false;
  const [[row]] = await pool.query('SELECT wholesale_token FROM settings WHERE id = 1');
  return !!row?.wholesale_token && row.wholesale_token === token;
}

module.exports = { isValidWholesaleToken };
