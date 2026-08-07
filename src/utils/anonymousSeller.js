const ANONYMOUS_SELLER_MARKER = 'anonymous-seller@internal.local';
const ANONYMOUS_SELLER_NAME = 'Anonymous Seller';

/** Looks up the shared wholesale-checkout seller id seeded by migrate.js -
 *  orders placed via the no-login wholesale-view link attribute to this
 *  account (role Seller, so cost pricing applies), the same way guest retail
 *  checkouts attribute to the Anonymous customer. */
async function getAnonymousSellerId(pool) {
  const [[row]] = await pool.query('SELECT id FROM users WHERE email = ?', [ANONYMOUS_SELLER_MARKER]);
  if (!row) {
    throw new Error('Anonymous seller is not configured');
  }
  return row.id;
}

module.exports = { ANONYMOUS_SELLER_MARKER, ANONYMOUS_SELLER_NAME, getAnonymousSellerId };
