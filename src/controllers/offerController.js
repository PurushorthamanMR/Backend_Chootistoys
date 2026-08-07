const pool = require('../config/db');

function canManage(user) {
  return user && ['Admin', 'SuperAdmin'].includes(user.role);
}

async function listOffers(req, res) {
  try {
    const { active } = req.query;
    let isActive = 1;
    if (canManage(req.user) && active !== undefined) {
      isActive = active === '0' || active === 'false' ? 0 : 1;
    }
    const [rows] = await pool.query('SELECT * FROM offers WHERE is_active = ? ORDER BY created_at DESC', [isActive]);
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Failed to fetch offers' });
  }
}

async function createOffer(req, res) {
  try {
    const { image } = req.body;
    if (!image) return res.status(400).json({ message: 'Image is required' });
    const [result] = await pool.query('INSERT INTO offers (image) VALUES (?)', [image]);
    res.status(201).json({ id: result.insertId, image, is_active: 1 });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Failed to create offer' });
  }
}

async function updateOffer(req, res) {
  try {
    const { id } = req.params;
    const { image } = req.body;
    if (!image) return res.status(400).json({ message: 'Image is required' });
    await pool.query('UPDATE offers SET image = ? WHERE id = ?', [image, id]);
    res.json({ message: 'Offer updated' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Failed to update offer' });
  }
}

async function deleteOffer(req, res) {
  try {
    const { id } = req.params;
    await pool.query('UPDATE offers SET is_active = 0 WHERE id = ?', [id]);
    res.json({ message: 'Offer deactivated' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Failed to deactivate offer' });
  }
}

async function restoreOffer(req, res) {
  try {
    const { id } = req.params;
    await pool.query('UPDATE offers SET is_active = 1 WHERE id = ?', [id]);
    res.json({ message: 'Offer restored' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Failed to restore offer' });
  }
}

module.exports = { listOffers, createOffer, updateOffer, deleteOffer, restoreOffer };
