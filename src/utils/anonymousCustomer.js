const ANONYMOUS_WHATSAPP_MARKER = 'anonymous-guest';
const ANONYMOUS_NAME = 'Anonymous';

/** Looks up the shared guest-checkout customer id seeded by migrate.js. */
async function getAnonymousCustomerId(pool) {
  const [[row]] = await pool.query('SELECT id FROM customers WHERE whatsapp_number = ?', [ANONYMOUS_WHATSAPP_MARKER]);
  if (!row) {
    throw new Error('Anonymous customer is not configured');
  }
  return row.id;
}

module.exports = { ANONYMOUS_WHATSAPP_MARKER, ANONYMOUS_NAME, getAnonymousCustomerId };
