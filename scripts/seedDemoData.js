/**
 * One-off demo/test data seeder - NOT wired into the app.
 * Run manually with: node scripts/seedDemoData.js
 *
 * Tops categories up to 30 (10 products each) and backfills ~3 months of
 * order history so the analytics-driven home page / admin dashboard have
 * something realistic to show for local testing and client demos.
 */
require('dotenv').config();
const mysql = require('mysql2/promise');
const bcrypt = require('bcryptjs');

function slugify(text) {
  return text
    .toString()
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)+/g, '');
}

function randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function pick(arr) {
  return arr[randInt(0, arr.length - 1)];
}

function weightedPick(items, weights) {
  const total = weights.reduce((a, b) => a + b, 0);
  let r = Math.random() * total;
  for (let i = 0; i < items.length; i++) {
    r -= weights[i];
    if (r <= 0) return items[i];
  }
  return items[items.length - 1];
}

const NEW_CATEGORIES = [
  'Action Figures',
  'Board Games',
  'Art & Craft Kits',
  'Science & STEM Kits',
  'Musical Toys',
  'Water & Pool Toys',
  'Sports & Outdoor Games',
  'Puzzles & Brain Games',
  'Play Tents & Playhouses',
  'Kitchen & Role Play Sets',
  'Drones & Flying Toys',
  'Party Supplies & Costumes',
  'Bath Toys',
  'Building Bricks',
  'Plush & Stuffed Animals',
  'Toy Vehicles & Trucks',
  'Dollhouses & Accessories',
  'Educational Tablets & Electronics',
  'Slime & Sensory Toys',
  'Card Games',
  'Wooden Toys',
  'Ride-On Bikes & Scooters',
  'Superhero Toys',
  'Baby Rattles & Teethers',
];

const PRODUCT_SUFFIXES = [
  'Deluxe Edition',
  'Classic Set',
  'Mini Version',
  'Pro Kit',
  'Starter Pack',
  'Family Pack',
  'Limited Edition',
  'Value Pack',
  'Premium Set',
  'Travel Edition',
];

const DEMO_CUSTOMER_NAMES = [
  'Nimal Perera',
  'Kavindi Fernando',
  'Ashan Silva',
  'Dilani Jayasuriya',
  'Ruwan Bandara',
  'Sanduni Rathnayake',
  'Tharindu Wijesinghe',
  'Chamodi Gunawardena',
  'Isuru Kumarasinghe',
  'Nadeesha Abeysekera',
  'Kasun Mendes',
  'Piumi Wickramasinghe',
  'Lahiru Dissanayake',
  'Hansika de Silva',
  'Chathura Ranasinghe',
];

const STATUS_WEIGHTS = { successful: 75, pending: 10, cancelled: 8, return: 7 };
const STATUSES = Object.keys(STATUS_WEIGHTS);
const STATUS_W = Object.values(STATUS_WEIGHTS);

async function main() {
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST,
    port: process.env.DB_PORT,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    multipleStatements: true,
  });

  try {
    // 1. Top categories up to 30
    const [existingCats] = await conn.query('SELECT id, name FROM categories');
    const existingNames = new Set(existingCats.map((c) => c.name));
    const toAdd = NEW_CATEGORIES.filter((n) => !existingNames.has(n));
    for (const name of toAdd) {
      const slug = slugify(name);
      await conn.query(
        'INSERT INTO categories (name, slug, image, is_active) VALUES (?, ?, ?, 1) ON DUPLICATE KEY UPDATE name = VALUES(name)',
        [name, slug, `https://picsum.photos/seed/${slug}/400/300`]
      );
    }
    const [categories] = await conn.query('SELECT id, name FROM categories WHERE is_active = 1');
    console.log(`[seed] ${categories.length} active categories (added ${toAdd.length} new).`);

    // 2. Top each category up to 10 products
    const [maxCodeRow] = await conn.query(
      `SELECT MAX(CAST(product_code AS UNSIGNED)) AS maxCode FROM products WHERE product_code REGEXP '^[0-9]+$'`
    );
    let nextCode = Math.max(2000, (maxCodeRow[0].maxCode || 0) + 1);

    let totalNewProducts = 0;
    for (const cat of categories) {
      const [[{ cnt }]] = await conn.query(
        'SELECT COUNT(*) AS cnt FROM products WHERE category_id = ?',
        [cat.id]
      );
      const needed = Math.max(0, 10 - cnt);
      for (let i = 0; i < needed; i++) {
        const suffix = PRODUCT_SUFFIXES[(cnt + i) % PRODUCT_SUFFIXES.length];
        const name = `${cat.name} ${suffix}`;
        const code = String(nextCode++);
        const slug = `${slugify(name)}-${code}`;
        const purchasePrice = randInt(500, 15000);
        const salePrice = Math.round(purchasePrice * (1.3 + Math.random() * 0.3));
        const discountPercent = Math.random() < 0.3 ? pick([5, 10, 15]) : 0;
        const stock = randInt(5, 60);
        const image = `https://picsum.photos/seed/prod-${code}/400/300`;
        await conn.query(
          `INSERT INTO products (category_id, name, slug, product_code, description, purchase_price, sale_price, discount_percent, stock, image, featured, is_active)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
          [
            cat.id,
            name,
            slug,
            code,
            `${name} - great addition to our ${cat.name.toLowerCase()} range.`,
            purchasePrice,
            salePrice,
            discountPercent,
            stock,
            image,
            Math.random() < 0.1 ? 1 : 0,
          ]
        );
        totalNewProducts++;
      }
    }
    console.log(`[seed] Added ${totalNewProducts} new products.`);

    const [products] = await conn.query('SELECT id, name, sale_price, discount_percent FROM products WHERE is_active = 1');
    const productWeights = products.map(() => randInt(1, 8)); // popularity bias for order generation

    // 3. Demo customers
    const [existingCustomers] = await conn.query('SELECT id, name, whatsapp_number FROM customers');
    const existingCustomerNames = new Set(existingCustomers.map((c) => c.name));
    const hashed = await bcrypt.hash('Demo@1234', 10);
    let phoneSeq = 941000000 + existingCustomers.length;
    for (const name of DEMO_CUSTOMER_NAMES) {
      if (existingCustomerNames.has(name)) continue;
      const phone = String(phoneSeq++);
      await conn.query(
        `INSERT INTO customers (name, whatsapp_number, password) VALUES (?, ?, ?)
         ON DUPLICATE KEY UPDATE name = VALUES(name)`,
        [name, phone, hashed]
      );
    }
    const [customers] = await conn.query('SELECT id FROM customers');
    console.log(`[seed] ${customers.length} customers available for demo orders.`);

    // 4. ~3 months of backdated orders
    const DAYS = 90;
    let orderCount = 0;
    let itemCount = 0;
    const now = Date.now();

    for (let day = DAYS; day >= 0; day--) {
      const ordersToday = randInt(1, 6);
      for (let o = 0; o < ordersToday; o++) {
        const dayStart = now - day * 24 * 60 * 60 * 1000;
        const createdAt = new Date(dayStart + randInt(0, 23) * 3600000 + randInt(0, 59) * 60000);
        const status = weightedPick(STATUSES, STATUS_W);
        const customerId = pick(customers).id;

        const itemsN = randInt(1, 3);
        const chosenIdx = new Set();
        while (chosenIdx.size < itemsN) {
          chosenIdx.add(weightedPick(products.map((_, i) => i), productWeights));
        }

        let total = 0;
        const lineItems = [];
        for (const idx of chosenIdx) {
          const p = products[idx];
          const qty = randInt(1, 3);
          const unitPrice = Number(p.discount_percent) > 0
            ? Math.round(p.sale_price * (1 - p.discount_percent / 100))
            : Number(p.sale_price);
          total += unitPrice * qty;
          lineItems.push({ productId: p.id, productName: p.name, qty, unitPrice });
        }

        const [orderResult] = await conn.query(
          `INSERT INTO orders (customer_id, total_amount, status, payment_method, shipping_name, shipping_phone, shipping_address, created_at)
           VALUES (?, ?, ?, 'cod', 'Demo Customer', '94770000000', 'Colombo, Sri Lanka', ?)`,
          [customerId, total, status, createdAt]
        );
        orderCount++;

        for (const item of lineItems) {
          await conn.query(
            `INSERT INTO order_items (order_id, product_id, product_name, price, quantity) VALUES (?, ?, ?, ?, ?)`,
            [orderResult.insertId, item.productId, item.productName, item.unitPrice, item.qty]
          );
          itemCount++;
        }
      }
    }
    console.log(`[seed] Created ${orderCount} orders spanning the last ${DAYS} days (${itemCount} line items).`);

    console.log('[seed] Done.');
  } finally {
    await conn.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
