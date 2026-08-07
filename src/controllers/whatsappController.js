const pool = require('../config/db');
const { createOrderRecord } = require('./orderController');
const { ANONYMOUS_NAME, getAnonymousCustomerId } = require('../utils/anonymousCustomer');
const { ANONYMOUS_SELLER_NAME, getAnonymousSellerId } = require('../utils/anonymousSeller');
const { isValidWholesaleToken } = require('../utils/wholesaleToken');
const { getWhatsappNumber } = require('../utils/settings');

const DIVIDER = '-'.repeat(24);

function formatRs(value) {
  return `Rs. ${Number(value).toLocaleString('en-LK', { maximumFractionDigits: 0 })}/=`;
}

function formatDateTime(date = new Date()) {
  return date.toLocaleString('en-LK', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function itemLabel(item) {
  return item.product_code ? `#${item.product_code}` : item.product_name;
}

// Customer (retail) order request - a plain, easy-to-scan bill.
function buildCustomerMessage(orderId, lineItems, total, senderName, senderPhone) {
  const itemLines = lineItems.map((item, index) => {
    return `${index + 1}. ${itemLabel(item)}\n    ${item.quantity} x ${formatRs(item.price)} = ${formatRs(item.price * item.quantity)}`;
  });
  return [
    '*City Cycle Stores - Order Request*',
    '',
    `*Order ID:* #${orderId}`,
    `*Customer:* ${senderName}`,
    senderPhone ? `*Contact:* ${senderPhone}` : null,
    `*Date:* ${formatDateTime()}`,
    DIVIDER,
    ...itemLines,
    DIVIDER,
    `*Total: ${formatRs(total)}*`,
    '',
    'Our staff will contact you soon. Thanks for your patience.',
  ].filter((line) => line !== null).join('\n');
}

// Seller (wholesale) order request - same shape but visually distinct
// (different header, cost-price labelling) so it's easy to tell apart from
// a retail order at a glance in the admin's WhatsApp chat.
function buildSellerMessage(orderId, lineItems, total, senderName, senderPhone, shopName, city) {
  const itemLines = lineItems.map((item, index) => {
    return `${index + 1}. ${itemLabel(item)}\n    ${item.quantity} x ${formatRs(item.price)} (cost) = ${formatRs(item.price * item.quantity)}`;
  });
  return [
    '*City Cycle Stores - Seller Order*',
    '',
    `*Order ID:* #${orderId}`,
    `*Seller:* ${senderName}`,
    senderPhone ? `*Contact:* ${senderPhone}` : null,
    shopName ? `*Shop:* ${shopName}` : null,
    city ? `*City:* ${city}` : null,
    `*Date:* ${formatDateTime()}`,
    DIVIDER,
    ...itemLines,
    DIVIDER,
    `*Total (Cost Price): ${formatRs(total)}*`,
    '',
    'Our staff will contact you soon. Thanks for your patience.',
  ].filter((line) => line !== null).join('\n');
}

// New seller application - sent as a WhatsApp deep link the applicant opens
// themselves (see authController.applySeller), same as order requests.
function buildSellerApplicationMessage(fullName, email, mobile) {
  return [
    '*City Cycle Stores - Seller Application*',
    '',
    `*Name:* ${fullName}`,
    `*Email:* ${email}`,
    `*Mobile:* ${mobile}`,
    `*Applied:* ${formatDateTime()}`,
    '',
    'Our staff will review this application. Thanks for your patience.',
  ].join('\n');
}

async function sendOrderRequest(req, res) {
  const { items, wholesaleToken } = req.body;
  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ message: 'Cart is empty' });
  }

  // A guest who chose "Continue without login" has no req.user at all - their
  // order request is attributed to the shared Anonymous customer seeded in
  // migrate.js, so it still has somewhere valid to attach (orders.customer_id).
  //
  // A no-login order that instead carries a valid wholesale link token comes
  // from the wholesale-view page - those attribute to the Anonymous Seller
  // staff account instead, so they get cost pricing and the seller-style
  // WhatsApp message, the same as a real logged-in Seller placing an order.
  const isGuest = !req.user;
  const isWholesaleGuest = isGuest && (await isValidWholesaleToken(wholesaleToken));
  const isSeller = isWholesaleGuest || (!isGuest && req.user.type === 'staff' && req.user.role === 'Seller');
  const requesterName = isWholesaleGuest ? ANONYMOUS_SELLER_NAME : isGuest ? ANONYMOUS_NAME : req.user.name;

  const connection = await pool.getConnection();
  let orderResult;
  let requester;
  try {
    await connection.beginTransaction();
    requester = isWholesaleGuest
      ? { type: 'staff', id: await getAnonymousSellerId(pool), name: ANONYMOUS_SELLER_NAME, phone: null }
      : isGuest
        ? { type: 'customer', id: await getAnonymousCustomerId(pool), name: ANONYMOUS_NAME, phone: null }
        : { type: req.user.type, id: req.user.id, name: req.user.name, phone: req.user.phone };
    orderResult = await createOrderRecord(connection, requester, items, {
      priceMode: isSeller ? 'cost' : 'retail',
    });
    await connection.commit();
  } catch (err) {
    await connection.rollback();
    console.error(err);
    return res.status(400).json({ message: err.message || 'Failed to place order' });
  } finally {
    connection.release();
  }

  let senderPhone = isGuest ? null : req.user.phone || null;
  if (!isGuest && !senderPhone) {
    if (req.user.type === 'customer') {
      const [rows] = await pool.query('SELECT whatsapp_number FROM customers WHERE id = ?', [req.user.id]);
      if (rows.length > 0) senderPhone = rows[0].whatsapp_number;
    } else if (req.user.id !== 0) {
      const [rows] = await pool.query('SELECT phone FROM users WHERE id = ?', [req.user.id]);
      if (rows.length > 0) senderPhone = rows[0].phone;
    }
  }

  let shopName = null;
  let city = null;
  if (isSeller) {
    const [rows] = await pool.query('SELECT shop_name, city FROM users WHERE id = ?', [requester.id]);
    if (rows.length > 0) {
      shopName = rows[0].shop_name;
      city = rows[0].city;
    }
  }

  const adminNumber = await getWhatsappNumber(pool);
  const message = isSeller
    ? buildSellerMessage(orderResult.orderId, orderResult.lineItems, orderResult.total, requesterName, senderPhone, shopName, city)
    : buildCustomerMessage(orderResult.orderId, orderResult.lineItems, orderResult.total, requesterName, senderPhone);

  // Order requests open WhatsApp on the requester's own device with the
  // message pre-filled, instead of being auto-sent from the server. That
  // way the resulting chat is a real conversation with the admin (not a
  // message from a bot account), and avoids the ban risk of automated sends.
  res.status(201).json({
    id: orderResult.orderId,
    message: adminNumber
      ? 'Order placed!'
      : "Order placed! Our WhatsApp contact isn't set up yet - our team will reach out another way.",
    whatsapp: adminNumber ? { number: adminNumber, text: message } : null,
  });
}

module.exports = { sendOrderRequest, buildSellerApplicationMessage };
