const pool = require('../config/db');
const { parseFontsFromSnippet } = require('../utils/googleFonts');

// Public - every visitor's browser needs this to know which Google Fonts
// stylesheet to load for the site's currently active font.
async function listFonts(req, res) {
  try {
    const [fonts] = await pool.query('SELECT id, name, family_param FROM fonts ORDER BY name');
    res.json(fonts);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Failed to fetch fonts' });
  }
}

async function addFont(req, res) {
  try {
    const { snippet } = req.body;
    if (!snippet) return res.status(400).json({ message: 'Paste a Google Fonts <link> snippet' });

    const parsed = parseFontsFromSnippet(snippet);
    if (parsed.length === 0) {
      return res.status(400).json({ message: "Couldn't find a font in that snippet" });
    }

    const [existing] = await pool.query('SELECT name FROM fonts');
    const existingNames = new Set(existing.map((f) => f.name));
    const toInsert = parsed.filter((f) => !existingNames.has(f.name));

    for (const font of toInsert) {
      await pool.query('INSERT INTO fonts (name, family_param) VALUES (?, ?)', [font.name, font.family_param]);
    }

    const [fonts] = await pool.query('SELECT id, name, family_param FROM fonts ORDER BY name');
    res.json({ added: toInsert.map((f) => f.name), fonts });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Failed to add font' });
  }
}

module.exports = { listFonts, addFont };
