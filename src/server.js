require('dotenv').config();
const path = require('path');
const express = require('express');
const cors = require('cors');

const migrate = require('./db/migrate');
const authRoutes = require('./routes/authRoutes');
const categoryRoutes = require('./routes/categoryRoutes');
const subcategoryRoutes = require('./routes/subcategoryRoutes');
const productRoutes = require('./routes/productRoutes');
const orderRoutes = require('./routes/orderRoutes');
const userRoutes = require('./routes/userRoutes');
const customerRoutes = require('./routes/customerRoutes');
const whatsappRoutes = require('./routes/whatsappRoutes');
const uploadRoutes = require('./routes/uploadRoutes');
const offerRoutes = require('./routes/offerRoutes');
const bannerRoutes = require('./routes/bannerRoutes');
const analyticsRoutes = require('./routes/analyticsRoutes');
const wishlistRoutes = require('./routes/wishlistRoutes');
const blogRoutes = require('./routes/blogRoutes');
const settingsRoutes = require('./routes/settingsRoutes');
const wholesaleRoutes = require('./routes/wholesaleRoutes');
const fontRoutes = require('./routes/fontRoutes');

const app = express();

// In local dev (no FRONTEND_URL set) allow any origin. In production, set
// FRONTEND_URL to the site's real domain(s) - comma-separated if there's more
// than one (e.g. with and without "www"). Trailing slashes are stripped since
// the browser's Origin header never has one, and cors() matches by exact string.
const allowedOrigins = process.env.FRONTEND_URL?.split(',')
  .map((o) => o.trim().replace(/\/$/, ''))
  .filter(Boolean);
console.log(`[cors] Allowed origins: ${allowedOrigins?.length ? allowedOrigins.join(', ') : '* (FRONTEND_URL not set)'}`);
app.use(cors(allowedOrigins?.length ? { origin: allowedOrigins } : undefined));
app.use(express.json());
app.use('/uploads', express.static(path.join(__dirname, '../uploads')));
app.use('/img', express.static(path.join(__dirname, 'img')));

app.get('/api/health', (req, res) => res.json({ status: 'ok' }));

app.use('/api/auth', authRoutes);
app.use('/api/categories', categoryRoutes);
app.use('/api/subcategories', subcategoryRoutes);
app.use('/api/products', productRoutes);
app.use('/api/orders', orderRoutes);
app.use('/api/users', userRoutes);
app.use('/api/customers', customerRoutes);
app.use('/api/whatsapp', whatsappRoutes);
app.use('/api/uploads', uploadRoutes);
app.use('/api/offers', offerRoutes);
app.use('/api/banners', bannerRoutes);
app.use('/api/analytics', analyticsRoutes);
app.use('/api/wishlist', wishlistRoutes);
app.use('/api/blogs', blogRoutes);
app.use('/api/settings', settingsRoutes);
app.use('/api/wholesale', wholesaleRoutes);
app.use('/api/fonts', fontRoutes);

app.use((req, res) => {
  res.status(404).json({ message: 'Not found' });
});

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ message: 'Internal server error' });
});

const PORT = process.env.PORT || 5000;

async function start() {
  try {
    await migrate();
  } catch (err) {
    console.error('[db] Database migration failed, starting anyway:', err.message);
    console.error('[db] The SuperAdmin account will still work; other features need the database.');
  }

  app.listen(PORT, () => {
    const publicUrl = (process.env.BACKEND_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
    console.log(`City Cycle Stores API listening on port ${PORT}`);
    console.log(`Public URL: ${publicUrl}`);
  });
}

start();
