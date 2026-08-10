const { spawn } = require('child_process');

// Mirrors the table names in db/schema.sql - kept as an explicit whitelist
// (rather than trusting the query param directly) since it flows into a
// shell-spawned mysqldump argument.
const EXPORTABLE_TABLES = [
  'user_roles', 'users', 'customers', 'categories', 'subcategories', 'products',
  'orders', 'order_items', 'wishlist_items', 'offers', 'banners', 'blogs',
  'otp_codes', 'settings', 'fonts', 'home_sections',
];

function timestamp() {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '_');
}

/**
 * Streams a `mysqldump` run straight to the response as a file download - no
 * temp file. The DB password goes in via MYSQL_PWD (child process env), not
 * a -p<password> CLI arg, so it never shows up in this machine's process list.
 */
function runDump(res, extraArgs, filenameSuffix) {
  const { DB_HOST, DB_PORT, DB_USER, DB_PASSWORD, DB_NAME } = process.env;
  // db_name must come right after the connection flags and before any
  // --tables argument - mysqldump treats every bare (non "--") argument
  // that follows --tables as a table name, so a db_name placed after it
  // gets silently swallowed as an (nonexistent) extra table instead of
  // being used as the database to dump.
  const args = [
    '-h', DB_HOST || 'localhost',
    '-P', DB_PORT || '3306',
    '-u', DB_USER || 'root',
    DB_NAME,
    ...extraArgs,
  ];

  const child = spawn('mysqldump', args, {
    env: { ...process.env, MYSQL_PWD: DB_PASSWORD || '' },
  });

  let headersSent = false;
  let stderr = '';

  child.stdout.once('data', () => {
    if (headersSent) return;
    headersSent = true;
    res.setHeader('Content-Type', 'application/sql');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${DB_NAME}_${filenameSuffix}_${timestamp()}.sql"`
    );
  });
  child.stdout.pipe(res);

  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
  });

  child.on('error', (err) => {
    if (res.headersSent) {
      console.error(`[export] mysqldump failed mid-stream (${filenameSuffix}):`, err.message);
      return res.end();
    }
    if (err.code === 'ENOENT') {
      return res.status(500).json({ message: 'mysqldump was not found on this server\'s PATH.' });
    }
    res.status(500).json({ message: `Failed to run mysqldump: ${err.message}` });
  });

  child.on('close', (code) => {
    if (code !== 0 && !res.headersSent) {
      res.status(500).json({ message: `mysqldump exited with an error: ${stderr.trim() || `code ${code}`}` });
    } else if (code !== 0) {
      console.error(`[export] mysqldump (${filenameSuffix}) exited with code ${code}:`, stderr.trim());
    }
  });
}

function exportStructure(req, res) {
  runDump(res, ['--no-data', '--routines', '--triggers'], 'structure');
}

function exportData(req, res) {
  const { table } = req.query;
  if (table) {
    if (!EXPORTABLE_TABLES.includes(table)) {
      return res.status(400).json({ message: `Unknown table: ${table}` });
    }
    return runDump(res, ['--no-create-info', '--tables', table], `data_${table}`);
  }
  runDump(res, ['--no-create-info'], 'data');
}

module.exports = { exportStructure, exportData, EXPORTABLE_TABLES };
