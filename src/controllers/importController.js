const { spawn } = require('child_process');
const pool = require('../config/db');

// Only the exact lines mysqldump's --no-create-info --tables settings output
// produces are allowed through - anything else (a different table's INSERT,
// a DROP/ALTER/DELETE, or a hand-edited file) fails validation and nothing
// gets executed. Returns the list of INSERT statements, or null if invalid.
function extractSettingsInserts(sql) {
  const lines = sql.split(/\r?\n/);
  const inserts = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('--')) continue;
    if (/^\/\*.*\*\/;?$/.test(line)) continue;
    if (/^(LOCK TABLES|UNLOCK TABLES)\b/i.test(line)) continue;
    if (/^INSERT INTO `settings`/i.test(line)) {
      inserts.push(line);
      continue;
    }
    return null;
  }
  return inserts.length > 0 ? inserts : null;
}

/**
 * Runs the import script through the `mysql` CLI (same connection args as
 * exportController's mysqldump) rather than the app's connection pool, so
 * the exact SQL mysqldump produced is executed as-is instead of being
 * re-parsed by a hand-rolled statement splitter.
 */
function runImportScript(script) {
  return new Promise((resolve, reject) => {
    const { DB_HOST, DB_PORT, DB_USER, DB_PASSWORD, DB_NAME } = process.env;
    const child = spawn(
      'mysql',
      ['-h', DB_HOST || 'localhost', '-P', DB_PORT || '3306', '-u', DB_USER || 'root', DB_NAME],
      { env: { ...process.env, MYSQL_PWD: DB_PASSWORD || '' } }
    );

    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error(stderr.trim() || `mysql exited with code ${code}`));
      resolve();
    });

    child.stdin.write(script);
    child.stdin.end();
  });
}

async function importSettingsData(req, res) {
  if (!req.file) {
    return res.status(400).json({ message: 'No file provided' });
  }

  const inserts = extractSettingsInserts(req.file.buffer.toString('utf8'));
  if (!inserts) {
    return res.status(400).json({
      message:
        'This doesn\'t look like a Settings-only export. Upload the file from "Export Data" with the settings table selected.',
    });
  }

  // Wrapped in a transaction (and the row is deleted+reinserted, not
  // updated column-by-column) so a partial failure can't leave the
  // settings table empty - the mysql client rolls back on disconnect if
  // COMMIT is never reached.
  const script = ['START TRANSACTION;', 'DELETE FROM settings WHERE id = 1;', ...inserts, 'COMMIT;'].join('\n');

  try {
    await runImportScript(script);
    const [[settings]] = await pool.query('SELECT * FROM settings WHERE id = 1');
    res.json({ message: 'Settings imported successfully', settings });
  } catch (err) {
    console.error('[import] Settings import failed:', err.message);
    if (err.code === 'ENOENT') {
      return res.status(500).json({ message: 'mysql was not found on this server\'s PATH.' });
    }
    res.status(500).json({ message: 'Failed to import settings data. The file may be corrupted or invalid.' });
  }
}

module.exports = { importSettingsData };
