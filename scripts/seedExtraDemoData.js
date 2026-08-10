/**
 * One-off demo/test data seeder - NOT wired into the app.
 * Run manually with: node scripts/seedExtraDemoData.js
 *
 * Complements seedDemoData.js (which handles categories/products/customers/
 * orders) by filling in the tables it doesn't touch: subcategories, banners,
 * offers, blogs - so every home page section has something to show.
 */
require('dotenv').config();
const mysql = require('mysql2/promise');

function slugify(text) {
  return text
    .toString()
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)+/g, '');
}

const SUBCATEGORY_MAP = {
  'Action Figures': ['Superhero Figures', 'Movie Character Figures', 'Collectible Figures'],
  'Board Games': ['Family Board Games', 'Strategy Games', 'Party Board Games'],
  'Building Bricks': ['Vehicle Sets', 'Castle & Fantasy Sets', 'City Sets'],
  'Plush & Stuffed Animals': ['Teddy Bears', 'Animal Plushies', 'Character Plushies'],
  'Toy Vehicles & Trucks': ['Die-Cast Cars', 'Construction Trucks', 'Remote Control Cars'],
  'Puzzles & Brain Games': ['Jigsaw Puzzles', '3D Puzzles', 'Brain Teasers'],
  'Wooden Toys': ['Wooden Blocks', 'Wooden Vehicles', 'Wooden Learning Toys'],
  'Educational Tablets & Electronics': ['Learning Tablets', 'Coding Kits', 'Electronic Games'],
};

const BLOG_POSTS = [
  {
    subject: 'Top 10 Toys for Toddlers This Season',
    message:
      'From soft-touch building blocks to sensory plushies, here are our top picks to keep little hands busy and minds growing this season.',
  },
  {
    subject: 'How to Choose the Right STEM Kit for Your Child',
    message:
      'STEM kits come in all shapes and sizes. Here is a quick guide to picking the right one based on your child\'s age and interests.',
  },
];

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
    // 1. Subcategories for a handful of categories
    const [categories] = await conn.query('SELECT id, name FROM categories WHERE is_active = 1');
    const catByName = new Map(categories.map((c) => [c.name, c]));
    let addedSubcats = 0;
    for (const [catName, subNames] of Object.entries(SUBCATEGORY_MAP)) {
      const cat = catByName.get(catName);
      if (!cat) continue;
      for (const subName of subNames) {
        const slug = slugify(`${catName}-${subName}`);
        const [existing] = await conn.query('SELECT id FROM subcategories WHERE slug = ?', [slug]);
        if (existing.length > 0) continue;
        await conn.query(
          'INSERT INTO subcategories (category_id, name, slug, image, is_active) VALUES (?, ?, ?, ?, 1)',
          [cat.id, subName, slug, `https://picsum.photos/seed/${slug}/400/300`]
        );
        addedSubcats++;
      }
    }
    console.log(`[seed] Added ${addedSubcats} new subcategories.`);

    // 2. Banners (home page carousel)
    const [existingBanners] = await conn.query('SELECT COUNT(*) AS cnt FROM banners WHERE is_active = 1');
    let addedBanners = 0;
    if (existingBanners[0].cnt === 0) {
      for (let i = 1; i <= 3; i++) {
        await conn.query('INSERT INTO banners (image, is_active) VALUES (?, 1)', [
          `https://picsum.photos/seed/toy-banner-${i}/1200/400`,
        ]);
        addedBanners++;
      }
    }
    console.log(`[seed] Added ${addedBanners} new banners.`);

    // 3. Offer (hero image on home page)
    const [existingOffers] = await conn.query('SELECT COUNT(*) AS cnt FROM offers WHERE is_active = 1');
    let addedOffers = 0;
    if (existingOffers[0].cnt === 0) {
      await conn.query('INSERT INTO offers (image, is_active) VALUES (?, 1)', [
        'https://picsum.photos/seed/toy-offer/1200/400',
      ]);
      addedOffers = 1;
    }
    console.log(`[seed] Added ${addedOffers} new offers.`);

    // 4. Blogs
    let addedBlogs = 0;
    for (const post of BLOG_POSTS) {
      const [existing] = await conn.query('SELECT id FROM blogs WHERE subject = ?', [post.subject]);
      if (existing.length > 0) continue;
      await conn.query('INSERT INTO blogs (subject, message, is_active) VALUES (?, ?, 1)', [
        post.subject,
        post.message,
      ]);
      addedBlogs++;
    }
    console.log(`[seed] Added ${addedBlogs} new blogs.`);

    console.log('[seed] Done.');
  } finally {
    await conn.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
