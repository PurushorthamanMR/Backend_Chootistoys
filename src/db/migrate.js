const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const mysql = require('mysql2/promise');
const bcrypt = require('bcryptjs');
const { ANONYMOUS_WHATSAPP_MARKER, ANONYMOUS_NAME } = require('../utils/anonymousCustomer');
const { ANONYMOUS_SELLER_MARKER, ANONYMOUS_SELLER_NAME } = require('../utils/anonymousSeller');

async function tableExists(connection, dbName, table) {
  const [rows] = await connection.query(
    `SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?`,
    [dbName, table]
  );
  return rows.length > 0;
}

async function getColumnNames(connection, dbName, table) {
  const [cols] = await connection.query(
    `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?`,
    [dbName, table]
  );
  return cols.map((c) => c.COLUMN_NAME);
}

async function migrateIsActive(connection, dbName, table, afterColumn) {
  if (!(await tableExists(connection, dbName, table))) return;
  const colNames = await getColumnNames(connection, dbName, table);
  if (colNames.includes('is_active')) return;

  console.log(`[db] Adding is_active column to ${table}...`);
  await connection.query(
    `ALTER TABLE ${table} ADD COLUMN is_active TINYINT(1) NOT NULL DEFAULT 1 AFTER ${afterColumn}`
  );
}

async function addColumnIfMissing(connection, dbName, table, column, definition, afterColumn) {
  if (!(await tableExists(connection, dbName, table))) return;
  const colNames = await getColumnNames(connection, dbName, table);
  if (colNames.includes(column)) return;

  console.log(`[db] Adding ${column} column to ${table}...`);
  await connection.query(
    `ALTER TABLE ${table} ADD COLUMN ${column} ${definition} AFTER ${afterColumn}`
  );
}

async function dropColumnIfExists(connection, dbName, table, column) {
  if (!(await tableExists(connection, dbName, table))) return;
  const colNames = await getColumnNames(connection, dbName, table);
  if (!colNames.includes(column)) return;

  console.log(`[db] Dropping ${column} column from ${table}...`);
  await connection.query(`ALTER TABLE ${table} DROP COLUMN ${column}`);
}

async function migrateUserStatusRejected(connection, dbName) {
  if (!(await tableExists(connection, dbName, 'users'))) return;
  const [rows] = await connection.query(
    `SELECT COLUMN_TYPE FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'users' AND COLUMN_NAME = 'status'`,
    [dbName]
  );
  if (rows.length === 0 || rows[0].COLUMN_TYPE.includes("'rejected'")) return;

  console.log('[db] Adding "rejected" to users.status enum...');
  await connection.query(
    `ALTER TABLE users MODIFY COLUMN status ENUM('pending', 'approved', 'rejected') NOT NULL DEFAULT 'approved'`
  );
}

async function migrateOrdersSchema(connection, dbName) {
  if (!(await tableExists(connection, dbName, 'orders'))) return;
  const colNames = await getColumnNames(connection, dbName, 'orders');

  if (!colNames.includes('customer_id')) {
    console.log('[db] Migrating orders table for customer support + new status set...');
    if (!(await tableExists(connection, dbName, 'customers'))) {
      await connection.query(`
        CREATE TABLE customers (
          id INT AUTO_INCREMENT PRIMARY KEY,
          name VARCHAR(100) NOT NULL,
          whatsapp_number VARCHAR(30) NOT NULL UNIQUE,
          email VARCHAR(150) DEFAULT NULL,
          password VARCHAR(255) NOT NULL,
          is_active TINYINT(1) NOT NULL DEFAULT 1,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `);
    }
    await connection.query(`ALTER TABLE orders ADD COLUMN customer_id INT NULL AFTER user_id`);
    await connection.query(`ALTER TABLE orders MODIFY COLUMN user_id INT NULL`);
    await connection.query(
      `ALTER TABLE orders ADD CONSTRAINT fk_orders_customer_id FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE`
    );
    await connection.query(`ALTER TABLE orders MODIFY COLUMN shipping_name VARCHAR(100) NULL`);
    await connection.query(`ALTER TABLE orders MODIFY COLUMN shipping_phone VARCHAR(30) NULL`);
    await connection.query(`ALTER TABLE orders MODIFY COLUMN shipping_address VARCHAR(255) NULL`);
  }

  const [statusCol] = await connection.query(
    `SELECT COLUMN_TYPE FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'orders' AND COLUMN_NAME = 'status'`,
    [dbName]
  );
  if (statusCol.length > 0 && statusCol[0].COLUMN_TYPE.includes("'processing'")) {
    console.log('[db] Migrating orders.status to Pending/Successful/Return/Cancelled...');
    await connection.query(
      `ALTER TABLE orders MODIFY COLUMN status VARCHAR(20) NOT NULL DEFAULT 'pending'`
    );
    await connection.query(`UPDATE orders SET status = 'pending' WHERE status IN ('processing', 'shipped')`);
    await connection.query(`UPDATE orders SET status = 'successful' WHERE status = 'delivered'`);
    await connection.query(
      `ALTER TABLE orders MODIFY COLUMN status ENUM('pending', 'successful', 'return', 'cancelled') NOT NULL DEFAULT 'pending'`
    );
  }
}

async function migrateCustomerName(connection, dbName) {
  if (!(await tableExists(connection, dbName, 'customers'))) return;
  const colNames = await getColumnNames(connection, dbName, 'customers');
  if (!colNames.includes('full_name') || colNames.includes('name')) return;

  console.log('[db] Renaming customers.full_name to customers.name...');
  await connection.query(`ALTER TABLE customers CHANGE COLUMN full_name name VARCHAR(100) NOT NULL`);
}

async function migrateProductPricing(connection, dbName) {
  const [tables] = await connection.query(
    `SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'products'`,
    [dbName]
  );
  if (tables.length === 0) return;

  const [cols] = await connection.query(
    `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'products'`,
    [dbName]
  );
  const colNames = cols.map((c) => c.COLUMN_NAME);
  const hasOldPrice = colNames.includes('price');

  if (!hasOldPrice) return;

  console.log('[db] Migrating products table to purchase/sale price + percentage discount...');

  if (!colNames.includes('purchase_price')) {
    await connection.query(
      `ALTER TABLE products ADD COLUMN purchase_price DECIMAL(10,2) NOT NULL DEFAULT 0 AFTER category_id`
    );
  }
  if (!colNames.includes('discount_percent')) {
    await connection.query(
      `ALTER TABLE products ADD COLUMN discount_percent DECIMAL(5,2) NOT NULL DEFAULT 0 AFTER price`
    );
    await connection.query(`
      UPDATE products
      SET discount_percent = CASE
        WHEN discount_price IS NOT NULL AND price > 0
        THEN ROUND((1 - discount_price / price) * 100, 2)
        ELSE 0
      END
    `);
  }

  await connection.query(`ALTER TABLE products DROP COLUMN discount_price`);
  await connection.query(`ALTER TABLE products CHANGE COLUMN price sale_price DECIMAL(10,2) NOT NULL`);
  await connection.query(`
    ALTER TABLE products
    ADD COLUMN discount_price DECIMAL(10,2)
    GENERATED ALWAYS AS (ROUND(sale_price - (sale_price * discount_percent / 100), 2)) STORED
    AFTER discount_percent
  `);

  console.log('[db] Product pricing migration complete.');
}

const SEED_PRODUCT_CODES = {
  'rc-car-4ch-drift-racing': '1001',
  'yp3-foam-aircraft-fighter': '1002',
  'sky-falcon-rc-mini-helicopter': '1003',
  'rc-rock-crawler-4wd': '1004',
  'building-puzzle-flying-scotsman': '1005',
  'rc-race-car-building-blocks': '1006',
  'kids-rotating-tower-ball-drop': '1007',
  'kids-ride-on-electric-car': '1008',
  'kids-spiderman-bodysuit-costume': '1009',
  'baby-girl-floral-romper': '1010',
  'postpartum-belly-band': '1011',
  'wooden-alphabet-learning-blocks': '1012',
};

async function migrateProductCode(connection, dbName) {
  const [tables] = await connection.query(
    `SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'products'`,
    [dbName]
  );
  if (tables.length === 0) return;

  const [cols] = await connection.query(
    `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'products'`,
    [dbName]
  );
  const colNames = cols.map((c) => c.COLUMN_NAME);

  if (!colNames.includes('product_code')) {
    console.log('[db] Adding product_code column to products...');
    await connection.query(
      `ALTER TABLE products ADD COLUMN product_code VARCHAR(50) DEFAULT NULL UNIQUE AFTER slug`
    );
  }

  for (const [slug, code] of Object.entries(SEED_PRODUCT_CODES)) {
    await connection.query(
      `UPDATE products SET product_code = ? WHERE slug = ? AND product_code IS NULL`,
      [code, slug]
    );
  }
}

async function migrateOrderItemsProductCode(connection, dbName) {
  if (!(await tableExists(connection, dbName, 'order_items'))) return;
  const colNames = await getColumnNames(connection, dbName, 'order_items');
  if (colNames.includes('product_code')) return;

  console.log('[db] Adding product_code column to order_items...');
  await connection.query(
    `ALTER TABLE order_items ADD COLUMN product_code VARCHAR(50) DEFAULT NULL AFTER product_name`
  );
  await connection.query(`
    UPDATE order_items oi JOIN products p ON p.id = oi.product_id
    SET oi.product_code = p.product_code
    WHERE oi.product_code IS NULL
  `);
}

async function migrateOrderItemsReturnedQuantity(connection, dbName) {
  if (!(await tableExists(connection, dbName, 'order_items'))) return;
  const colNames = await getColumnNames(connection, dbName, 'order_items');
  if (colNames.includes('returned_quantity')) return;

  console.log('[db] Adding returned_quantity column to order_items...');
  await connection.query(
    `ALTER TABLE order_items ADD COLUMN returned_quantity INT NOT NULL DEFAULT 0 AFTER quantity`
  );
}

async function migrateUserRoles(connection, dbName) {
  await connection.query(`
    CREATE TABLE IF NOT EXISTS user_roles (
      id INT AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(20) NOT NULL UNIQUE
    )
  `);
  await connection.query(`
    INSERT INTO user_roles (name) VALUES ('SuperAdmin'), ('Admin'), ('Seller'), ('Customer')
    ON DUPLICATE KEY UPDATE name = VALUES(name)
  `);

  const [tables] = await connection.query(
    `SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'users'`,
    [dbName]
  );
  if (tables.length === 0) return;

  const [cols] = await connection.query(
    `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'users'`,
    [dbName]
  );
  const colNames = cols.map((c) => c.COLUMN_NAME);
  if (!colNames.includes('role')) return;

  console.log('[db] Migrating users.role (enum) to users.role_id (FK to user_roles)...');

  if (!colNames.includes('role_id')) {
    await connection.query(`ALTER TABLE users ADD COLUMN role_id INT NULL AFTER role`);
  }

  const roleMap = { customer: 'Customer', seller: 'Seller', admin: 'Admin', superadmin: 'SuperAdmin' };
  for (const [oldVal, newName] of Object.entries(roleMap)) {
    await connection.query(
      `UPDATE users u JOIN user_roles r ON r.name = ? SET u.role_id = r.id WHERE u.role = ? AND u.role_id IS NULL`,
      [newName, oldVal]
    );
  }
  await connection.query(`
    UPDATE users u JOIN user_roles r ON r.name = 'Customer'
    SET u.role_id = r.id WHERE u.role_id IS NULL
  `);

  await connection.query(`ALTER TABLE users MODIFY COLUMN role_id INT NOT NULL`);
  await connection.query(`ALTER TABLE users DROP COLUMN role`);
  await connection.query(`
    ALTER TABLE users ADD CONSTRAINT fk_users_role_id FOREIGN KEY (role_id) REFERENCES user_roles(id)
  `);

  console.log('[db] users.role_id migration complete.');
}

async function migrateUserStatus(connection, dbName) {
  const [tables] = await connection.query(
    `SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'users'`,
    [dbName]
  );
  if (tables.length === 0) return;

  const [cols] = await connection.query(
    `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'users'`,
    [dbName]
  );
  const colNames = cols.map((c) => c.COLUMN_NAME);
  if (colNames.includes('status')) return;

  console.log('[db] Adding status column to users (pending/approved)...');
  await connection.query(
    `ALTER TABLE users ADD COLUMN status ENUM('pending', 'approved') NOT NULL DEFAULT 'approved' AFTER role_id`
  );
}

const CORE_USERS = [
  {
    name: 'Super Admin',
    getEmail: () => process.env.SUPERADMIN_USERNAME || 'Prusoth26',
    getPassword: () => process.env.SUPERADMIN_PASSWORD || 'Pruso2002',
    phone: '0765947337',
    address: 'Nallur',
    role: 'SuperAdmin',
  },
  {
    name: 'Admin',
    getEmail: () => 'Admin@gmail.com',
    getPassword: () => 'Admin123',
    phone: '0123456789',
    address: 'Colombo',
    role: 'Admin',
  },
];

async function ensureCoreUsers(connection) {
  for (const def of CORE_USERS) {
    const email = def.getEmail();
    const password = def.getPassword();

    const [[role]] = await connection.query('SELECT id FROM user_roles WHERE name = ?', [def.role]);
    if (!role) continue;

    const matchByRole = def.role === 'SuperAdmin';
    const [existing] = await connection.query(
      matchByRole
        ? `SELECT u.id FROM users u
           JOIN user_roles r ON r.id = u.role_id
           WHERE u.email = ? OR r.name = 'SuperAdmin'
           ORDER BY CASE WHEN u.email = ? THEN 0 ELSE 1 END
           LIMIT 1`
        : `SELECT id FROM users WHERE email = ? LIMIT 1`,
      matchByRole ? [email, email] : [email]
    );

    const hashed = await bcrypt.hash(password, 10);
    if (existing.length > 0) {
      await connection.query(
        `UPDATE users SET name = ?, email = ?, password = ?, phone = ?, address = ?, role_id = ?, status = 'approved', is_active = 1 WHERE id = ?`,
        [def.name, email, hashed, def.phone, def.address, role.id, existing[0].id]
      );
      console.log(`[db] ${def.role} user updated (id=${existing[0].id}, email=${email}).`);
    } else {
      const [result] = await connection.query(
        `INSERT INTO users (name, email, password, phone, address, role_id, status, is_active) VALUES (?, ?, ?, ?, ?, ?, 'approved', 1)`,
        [def.name, email, hashed, def.phone, def.address, role.id]
      );
      console.log(`[db] ${def.role} user created (id=${result.insertId}, email=${email}).`);
    }
  }
}

async function migrateProductSubcategory(connection, dbName) {
  if (!(await tableExists(connection, dbName, 'products'))) return;
  const colNames = await getColumnNames(connection, dbName, 'products');
  if (colNames.includes('subcategory_id')) return;

  console.log('[db] Adding subcategory_id column to products...');
  await connection.query(`ALTER TABLE products ADD COLUMN subcategory_id INT NULL AFTER category_id`);
  await connection.query(
    `ALTER TABLE products ADD CONSTRAINT fk_products_subcategory_id FOREIGN KEY (subcategory_id) REFERENCES subcategories(id) ON DELETE SET NULL`
  );
}

/** Seeds the shared guest-checkout customer, looked up by a reserved marker
 *  (not a hardcoded id) so it works regardless of existing table state. */
async function ensureAnonymousCustomer(connection) {
  const [existing] = await connection.query(
    'SELECT id FROM customers WHERE whatsapp_number = ? LIMIT 1',
    [ANONYMOUS_WHATSAPP_MARKER]
  );
  if (existing.length > 0) return;

  const randomPassword = crypto.randomBytes(32).toString('hex');
  const hashed = await bcrypt.hash(randomPassword, 10);
  const [result] = await connection.query(
    'INSERT INTO customers (name, whatsapp_number, password) VALUES (?, ?, ?)',
    [ANONYMOUS_NAME, ANONYMOUS_WHATSAPP_MARKER, hashed]
  );
  console.log(`[db] Anonymous guest customer created (id=${result.insertId}).`);
}

/** Seeds the shared wholesale-checkout seller (a staff user with role
 *  Seller), looked up by a reserved marker email - orders placed via the
 *  no-login wholesale-view link attribute to this account so they get
 *  cost pricing and show up distinctly in the admin's order list. */
async function ensureAnonymousSeller(connection) {
  const [existing] = await connection.query(
    'SELECT id FROM users WHERE email = ? LIMIT 1',
    [ANONYMOUS_SELLER_MARKER]
  );
  if (existing.length > 0) return;

  const [[role]] = await connection.query("SELECT id FROM user_roles WHERE name = 'Seller'");
  if (!role) return;

  const randomPassword = crypto.randomBytes(32).toString('hex');
  const hashed = await bcrypt.hash(randomPassword, 10);
  const [result] = await connection.query(
    `INSERT INTO users (name, email, password, role_id, status, is_active) VALUES (?, ?, ?, ?, 'approved', 1)`,
    [ANONYMOUS_SELLER_NAME, ANONYMOUS_SELLER_MARKER, hashed, role.id]
  );
  console.log(`[db] Anonymous seller user created (id=${result.insertId}).`);
}

/** Seeds the single settings row, carrying forward ADMIN_WHATSAPP_NUMBER from
 *  .env (if set) so an existing deployment keeps its configured number after
 *  the env var is removed in favor of the Admin Settings page. */
async function ensureSettingsRow(connection) {
  const [existing] = await connection.query('SELECT id FROM settings WHERE id = 1');
  if (existing.length > 0) return;

  await connection.query(
    'INSERT INTO settings (id, whatsapp_number) VALUES (1, ?)',
    [process.env.ADMIN_WHATSAPP_NUMBER || null]
  );
  console.log('[db] Settings row created.');
}

/** Ensures the wholesale-view share link has a secret token, generating one
 *  the first time this runs (fresh install or upgrade from a version without
 *  the wholesale view feature). */
async function ensureWholesaleToken(connection) {
  const [[row]] = await connection.query('SELECT wholesale_token FROM settings WHERE id = 1');
  if (row?.wholesale_token) return;

  const token = crypto.randomBytes(24).toString('hex');
  await connection.query('UPDATE settings SET wholesale_token = ? WHERE id = 1', [token]);
  console.log('[db] Wholesale view token generated.');
}

const DEFAULT_TERMS_CONTENT = `Update Soon`;

const DEFAULT_RETURN_POLICY_CONTENT = `Update Soon`;

const DEFAULT_PRIVACY_POLICY_CONTENT = `Update Soon`;

const DEFAULT_ABOUT_CONTENT = `Update Soon`;

/** Seeds default Terms/Return/Privacy/About content the first time these
 *  columns are empty, so the public pages aren't blank out of the box - the
 *  admin can rewrite this from the Admin Settings > Legal Pages / About Us section. */
async function ensureLegalContent(connection) {
  await connection.query(
    `UPDATE settings SET
       terms_content = COALESCE(terms_content, ?),
       return_policy_content = COALESCE(return_policy_content, ?),
       privacy_policy_content = COALESCE(privacy_policy_content, ?),
       about_content = COALESCE(about_content, ?)
     WHERE id = 1`,
    [DEFAULT_TERMS_CONTENT, DEFAULT_RETURN_POLICY_CONTENT, DEFAULT_PRIVACY_POLICY_CONTENT, DEFAULT_ABOUT_CONTENT]
  );
}

// Google Fonts CSS2 "family" query values for the 10 starter fonts (Admin
// Settings > Font Style). Store owners can add more by pasting a Google
// Fonts <link> snippet, parsed by utils/googleFonts.js.
const DEFAULT_FONTS = [
  ['Archivo Narrow', 'Archivo+Narrow:ital,wght@0,400..700;1,400..700'],
  ['Cormorant Garamond', 'Cormorant+Garamond:ital,wght@0,300..700;1,300..700'],
  ['DM Sans', 'DM+Sans:ital,opsz,wght@0,9..40,100..1000;1,9..40,100..1000'],
  ['Libertinus Math', 'Libertinus+Math'],
  ['Merriweather', 'Merriweather:ital,opsz,wght@0,18..144,300..900;1,18..144,300..900'],
  ['Montserrat', 'Montserrat:ital,wght@0,100..900;1,100..900'],
  ['Playfair Display', 'Playfair+Display:ital,wght@0,400..900;1,400..900'],
  ['Roboto Condensed', 'Roboto+Condensed:ital,wght@0,100..900;1,100..900'],
  ['Share Tech', 'Share+Tech'],
  ['Titillium Web', 'Titillium+Web:ital,wght@0,200;0,300;0,400;0,600;0,700;0,900;1,200;1,300;1,400;1,600;1,700'],
];

async function ensureDefaultFonts(connection) {
  const [[{ count }]] = await connection.query('SELECT COUNT(*) as count FROM fonts');
  if (count > 0) return;
  for (const [name, family_param] of DEFAULT_FONTS) {
    await connection.query('INSERT INTO fonts (name, family_param) VALUES (?, ?)', [name, family_param]);
  }
}

async function migrate() {
  const { DB_HOST, DB_PORT, DB_USER, DB_PASSWORD, DB_NAME } = process.env;

  const connection = await mysql.createConnection({
    host: DB_HOST,
    port: DB_PORT,
    user: DB_USER,
    password: DB_PASSWORD,
    multipleStatements: true,
  });

  try {
    await connection.query(
      `CREATE DATABASE IF NOT EXISTS \`${DB_NAME}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`
    );
    await connection.query(`USE \`${DB_NAME}\``);

    await migrateUserRoles(connection, DB_NAME);
    await migrateUserStatus(connection, DB_NAME);
    await migrateUserStatusRejected(connection, DB_NAME);
    await migrateIsActive(connection, DB_NAME, 'users', 'status');
    await migrateProductPricing(connection, DB_NAME);
    await migrateProductCode(connection, DB_NAME);
    await migrateIsActive(connection, DB_NAME, 'products', 'featured');
    await migrateIsActive(connection, DB_NAME, 'categories', 'image');
    await migrateIsActive(connection, DB_NAME, 'customers', 'password');
    await migrateOrdersSchema(connection, DB_NAME);
    await migrateCustomerName(connection, DB_NAME);
    await migrateOrderItemsProductCode(connection, DB_NAME);
    await migrateOrderItemsReturnedQuantity(connection, DB_NAME);
    await addColumnIfMissing(connection, DB_NAME, 'users', 'shop_name', 'VARCHAR(150)', 'address');
    await addColumnIfMissing(connection, DB_NAME, 'users', 'city', 'VARCHAR(100)', 'shop_name');
    await addColumnIfMissing(connection, DB_NAME, 'users', 'image', 'VARCHAR(255)', 'city');
    await addColumnIfMissing(connection, DB_NAME, 'customers', 'image', 'VARCHAR(255)', 'email');
    await addColumnIfMissing(connection, DB_NAME, 'settings', 'store_logo', 'VARCHAR(255)', 'store_short_name');
    await addColumnIfMissing(connection, DB_NAME, 'settings', 'address', 'VARCHAR(255)', 'whatsapp_number');
    await addColumnIfMissing(connection, DB_NAME, 'settings', 'email', 'VARCHAR(150)', 'address');
    await addColumnIfMissing(connection, DB_NAME, 'settings', 'wholesale_token', 'VARCHAR(64) NULL', 'theme_color_dark');
    await addColumnIfMissing(connection, DB_NAME, 'settings', 'terms_content', 'LONGTEXT', 'wholesale_token');
    await addColumnIfMissing(connection, DB_NAME, 'settings', 'return_policy_content', 'LONGTEXT', 'terms_content');
    await addColumnIfMissing(connection, DB_NAME, 'settings', 'privacy_policy_content', 'LONGTEXT', 'return_policy_content');
    await addColumnIfMissing(connection, DB_NAME, 'settings', 'about_content', 'LONGTEXT', 'privacy_policy_content');
    // Historical anchor column for the next line, on DBs old enough to be missing active_font -
    // every such DB already has email_from from having booted a pre-EmailJS version of this app.
    await addColumnIfMissing(connection, DB_NAME, 'settings', 'active_font', "VARCHAR(150) NOT NULL DEFAULT 'Archivo Narrow'", 'email_from');
    await addColumnIfMissing(connection, DB_NAME, 'settings', 'store_icon', 'VARCHAR(255)', 'store_logo');

    // Brevo/SMTP -> EmailJS migration.
    await dropColumnIfExists(connection, DB_NAME, 'settings', 'smtp_host');
    await dropColumnIfExists(connection, DB_NAME, 'settings', 'smtp_port');
    await dropColumnIfExists(connection, DB_NAME, 'settings', 'smtp_user');
    await dropColumnIfExists(connection, DB_NAME, 'settings', 'smtp_pass');
    await dropColumnIfExists(connection, DB_NAME, 'settings', 'email_from');
    await addColumnIfMissing(connection, DB_NAME, 'settings', 'emailjs_service_id', 'VARCHAR(100)', 'privacy_policy_content');
    await addColumnIfMissing(connection, DB_NAME, 'settings', 'emailjs_public_key', 'VARCHAR(150)', 'emailjs_service_id');
    await addColumnIfMissing(connection, DB_NAME, 'settings', 'emailjs_private_key', 'VARCHAR(150)', 'emailjs_public_key');
    await addColumnIfMissing(connection, DB_NAME, 'settings', 'emailjs_reply_to', 'VARCHAR(150)', 'emailjs_private_key');
    await addColumnIfMissing(connection, DB_NAME, 'settings', 'emailjs_template_otp', 'VARCHAR(100)', 'emailjs_reply_to');
    // Free EmailJS plans only allow 2 templates, so every purpose funnels into one of these two:
    // emailjs_template_otp (OTP + forgot-password codes) and emailjs_template_notify (welcome + seller status).
    await dropColumnIfExists(connection, DB_NAME, 'settings', 'emailjs_template_forgot');
    await dropColumnIfExists(connection, DB_NAME, 'settings', 'emailjs_template_seller_applied');
    await dropColumnIfExists(connection, DB_NAME, 'settings', 'emailjs_template_seller_approved');
    if (await tableExists(connection, DB_NAME, 'settings')) {
      const colNames = await getColumnNames(connection, DB_NAME, 'settings');
      if (colNames.includes('emailjs_template_welcome') && !colNames.includes('emailjs_template_notify')) {
        console.log('[db] Renaming emailjs_template_welcome to emailjs_template_notify...');
        await connection.query(
          'ALTER TABLE settings CHANGE COLUMN emailjs_template_welcome emailjs_template_notify VARCHAR(100)'
        );
      }
    }
    await addColumnIfMissing(connection, DB_NAME, 'settings', 'emailjs_template_notify', 'VARCHAR(100)', 'emailjs_template_otp');

    // Local disk -> Google Drive image uploads (OAuth with a free Gmail account).
    await dropColumnIfExists(connection, DB_NAME, 'settings', 'drive_client_email');
    await dropColumnIfExists(connection, DB_NAME, 'settings', 'drive_private_key');
    await addColumnIfMissing(connection, DB_NAME, 'settings', 'drive_client_id', 'VARCHAR(255)', 'emailjs_template_notify');
    await addColumnIfMissing(connection, DB_NAME, 'settings', 'drive_client_secret', 'VARCHAR(255)', 'drive_client_id');
    await addColumnIfMissing(connection, DB_NAME, 'settings', 'drive_refresh_token', 'TEXT', 'drive_client_secret');
    await addColumnIfMissing(connection, DB_NAME, 'settings', 'drive_folder_id', 'VARCHAR(150)', 'drive_refresh_token');

    const schemaSql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
    await connection.query(schemaSql);

    await migrateProductSubcategory(connection, DB_NAME);

    await ensureCoreUsers(connection);
    await ensureAnonymousCustomer(connection);
    await ensureAnonymousSeller(connection);
    await ensureSettingsRow(connection);
    await ensureWholesaleToken(connection);
    await ensureLegalContent(connection);
    await ensureDefaultFonts(connection);

    console.log(`[db] Database "${DB_NAME}" and tables are ready.`);
  } finally {
    await connection.end();
  }
}

module.exports = migrate;
