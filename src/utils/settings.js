async function getWhatsappNumber(pool) {
  const [[settings]] = await pool.query('SELECT whatsapp_number FROM settings WHERE id = 1');
  return settings?.whatsapp_number || null;
}

module.exports = { getWhatsappNumber };
