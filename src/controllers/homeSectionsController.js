const pool = require('../config/db');
const { SECTION_KEYS } = require('../utils/homeSections');

// Public - the home page needs this to know what order/visibility to render
// its sections in.
async function listHomeSections(req, res) {
  try {
    const [rows] = await pool.query(
      'SELECT section_key, position, is_visible FROM home_sections ORDER BY position'
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Failed to fetch home sections' });
  }
}

async function updateHomeSections(req, res) {
  const sections = req.body?.sections;
  if (!Array.isArray(sections) || sections.length !== SECTION_KEYS.length) {
    return res.status(400).json({ message: 'All home sections must be provided' });
  }

  const seen = new Set();
  for (const s of sections) {
    if (!SECTION_KEYS.includes(s?.section_key) || seen.has(s.section_key)) {
      return res.status(400).json({ message: 'Invalid section list' });
    }
    seen.add(s.section_key);
    if (!Number.isInteger(s.position)) {
      return res.status(400).json({ message: 'Invalid section list' });
    }
  }

  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    for (const s of sections) {
      await connection.query(
        'UPDATE home_sections SET position = ?, is_visible = ? WHERE section_key = ?',
        [s.position, s.is_visible ? 1 : 0, s.section_key]
      );
    }
    await connection.commit();
    const [rows] = await connection.query(
      'SELECT section_key, position, is_visible FROM home_sections ORDER BY position'
    );
    res.json(rows);
  } catch (err) {
    await connection.rollback();
    console.error(err);
    res.status(500).json({ message: 'Failed to update home sections' });
  } finally {
    connection.release();
  }
}

module.exports = { listHomeSections, updateHomeSections };
