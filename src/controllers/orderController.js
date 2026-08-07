const pool = require('../config/db');

async function createOrderRecord(connection, requester, items, options = {}) {
  const priceMode = options.priceMode || 'retail';

  const productIds = items.map((i) => i.product_id);
  const [products] = await connection.query(
    `SELECT id, name, product_code, sale_price, discount_price, purchase_price, stock FROM products WHERE id IN (?)`,
    [productIds]
  );
  const productMap = new Map(products.map((p) => [p.id, p]));

  let total = 0;
  const lineItems = [];
  for (const item of items) {
    const product = productMap.get(item.product_id);
    if (!product) throw new Error(`Product ${item.product_id} not found`);
    const quantity = Number(item.quantity) || 1;
    if (product.stock < quantity) {
      throw new Error(`Not enough stock for ${product.name}`);
    }
    const unitPrice = priceMode === 'cost'
      ? Number(product.purchase_price)
      : Number(product.discount_price ?? product.sale_price);
    total += unitPrice * quantity;
    lineItems.push({
      product_id: product.id,
      product_name: product.name,
      product_code: product.product_code,
      price: unitPrice,
      quantity,
    });
  }

  const isCustomer = requester.type === 'customer';
  const shipping = options.shipping || {};

  const [orderResult] = await connection.query(
    `INSERT INTO orders (user_id, customer_id, total_amount, payment_method, shipping_name, shipping_phone, shipping_address, status)
     VALUES (?, ?, ?, 'cod', ?, ?, ?, 'pending')`,
    [
      isCustomer ? null : requester.id,
      isCustomer ? requester.id : null,
      total,
      shipping.name || requester.name || null,
      shipping.phone || requester.phone || null,
      shipping.address || null,
    ]
  );
  const orderId = orderResult.insertId;

  // Stock is not reduced here - an order only reserves stock once an admin
  // approves it (status -> successful), so a pile of pending requests can't
  // starve the catalog before anyone has actually confirmed them.
  for (const item of lineItems) {
    await connection.query(
      `INSERT INTO order_items (order_id, product_id, product_name, product_code, price, quantity) VALUES (?, ?, ?, ?, ?, ?)`,
      [orderId, item.product_id, item.product_name, item.product_code, item.price, item.quantity]
    );
  }

  return { orderId, total, lineItems };
}

async function placeOrder(req, res) {
  const { items, shipping_name, shipping_phone, shipping_address } = req.body;
  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ message: 'Cart is empty' });
  }
  if (!shipping_name || !shipping_phone || !shipping_address) {
    return res.status(400).json({ message: 'Shipping details are required' });
  }

  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const requester = { type: req.user.type, id: req.user.id, name: req.user.name, phone: req.user.phone };
    const priceMode = req.user.type === 'staff' && req.user.role === 'Seller' ? 'cost' : 'retail';
    const { orderId, total } = await createOrderRecord(connection, requester, items, {
      priceMode,
      shipping: { name: shipping_name, phone: shipping_phone, address: shipping_address },
    });
    await connection.commit();
    res.status(201).json({ id: orderId, total_amount: total, message: 'Order placed successfully' });
  } catch (err) {
    await connection.rollback();
    console.error(err);
    res.status(400).json({ message: err.message || 'Failed to place order' });
  } finally {
    connection.release();
  }
}

async function listMyOrders(req, res) {
  try {
    const canSeeCode = ['Admin', 'SuperAdmin'].includes(req.user.role);
    const column = req.user.type === 'customer' ? 'customer_id' : 'user_id';
    const [orders] = await pool.query(
      `SELECT * FROM orders WHERE ${column} = ? ORDER BY created_at DESC`,
      [req.user.id]
    );
    for (const order of orders) {
      const [items] = await pool.query(
        `SELECT oi.*, p.image AS product_image FROM order_items oi
         LEFT JOIN products p ON p.id = oi.product_id
         WHERE oi.order_id = ?`,
        [order.id]
      );
      if (!canSeeCode) items.forEach((item) => delete item.product_code);
      order.items = items;
    }
    res.json(orders);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Failed to fetch orders' });
  }
}

async function listAllOrders(req, res) {
  try {
    const [orders] = await pool.query(
      `SELECT o.*,
              COALESCE(u.name, c.name) AS customer_name,
              COALESCE(u.email, c.email) AS customer_email,
              COALESCE(u.phone, c.whatsapp_number) AS customer_phone,
              CASE WHEN o.customer_id IS NOT NULL THEN 'Customer' ELSE r.name END AS orderer_role
       FROM orders o
       LEFT JOIN users u ON u.id = o.user_id
       LEFT JOIN user_roles r ON r.id = u.role_id
       LEFT JOIN customers c ON c.id = o.customer_id
       ORDER BY o.created_at DESC`
    );
    for (const order of orders) {
      const [items] = await pool.query('SELECT * FROM order_items WHERE order_id = ?', [order.id]);
      order.items = items;
    }
    res.json(orders);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Failed to fetch orders' });
  }
}

async function updateOrderStatus(req, res) {
  const { id } = req.params;
  const { status } = req.body;
  const valid = ['pending', 'successful', 'return', 'cancelled'];
  if (!valid.includes(status)) return res.status(400).json({ message: 'Invalid status' });

  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    const [[order]] = await connection.query('SELECT * FROM orders WHERE id = ? FOR UPDATE', [id]);
    if (!order) {
      await connection.rollback();
      return res.status(404).json({ message: 'Order not found' });
    }

    const [items] = await connection.query('SELECT * FROM order_items WHERE order_id = ?', [id]);
    let totalAmount = Number(order.total_amount);

    if (status === 'successful' && order.status !== 'successful') {
      // First approval: this is the only point stock actually leaves the
      // catalog, so re-check availability now (it may have moved since the
      // request was placed).
      for (const item of items) {
        if (!item.product_id) continue;
        const [[product]] = await connection.query('SELECT stock, name FROM products WHERE id = ? FOR UPDATE', [item.product_id]);
        if (!product || product.stock < item.quantity) {
          await connection.rollback();
          return res.status(400).json({ message: `Not enough stock for ${item.product_name} to approve this order` });
        }
      }
      for (const item of items) {
        if (!item.product_id) continue;
        await connection.query('UPDATE products SET stock = stock - ? WHERE id = ?', [item.quantity, item.product_id]);
      }
    } else if (order.status === 'successful' && status !== 'successful') {
      // Leaving 'successful' (return/cancelled) hands back whatever hasn't
      // already been returned piecemeal.
      for (const item of items) {
        const outstanding = item.quantity - item.returned_quantity;
        if (outstanding > 0 && item.product_id) {
          await connection.query('UPDATE products SET stock = stock + ? WHERE id = ?', [outstanding, item.product_id]);
        }
      }
      if (status === 'return') {
        for (const item of items) {
          await connection.query('UPDATE order_items SET returned_quantity = quantity WHERE id = ?', [item.id]);
        }
        totalAmount = 0;
      }
    }

    await connection.query('UPDATE orders SET status = ?, total_amount = ? WHERE id = ?', [status, totalAmount, id]);
    await connection.commit();
    res.json({ message: 'Order status updated' });
  } catch (err) {
    await connection.rollback();
    console.error(err);
    res.status(500).json({ message: 'Failed to update order status' });
  } finally {
    connection.release();
  }
}

async function processReturn(req, res) {
  const { id } = req.params;
  const { items } = req.body;
  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ message: 'No return quantities provided' });
  }

  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    const [[order]] = await connection.query('SELECT * FROM orders WHERE id = ? FOR UPDATE', [id]);
    if (!order) {
      await connection.rollback();
      return res.status(404).json({ message: 'Order not found' });
    }
    if (order.status !== 'successful') {
      await connection.rollback();
      return res.status(400).json({ message: 'Only approved orders can be returned' });
    }

    const [orderItems] = await connection.query('SELECT * FROM order_items WHERE order_id = ? FOR UPDATE', [id]);
    const itemMap = new Map(orderItems.map((oi) => [oi.id, oi]));

    for (const req_item of items) {
      const qty = Number(req_item.quantity) || 0;
      if (qty <= 0) continue;
      const item = itemMap.get(Number(req_item.id));
      if (!item) {
        await connection.rollback();
        return res.status(400).json({ message: 'Invalid order item' });
      }
      const remaining = item.quantity - item.returned_quantity;
      if (qty > remaining) {
        await connection.rollback();
        return res.status(400).json({ message: `Cannot return more than ${remaining} of ${item.product_name}` });
      }

      await connection.query('UPDATE order_items SET returned_quantity = returned_quantity + ? WHERE id = ?', [qty, item.id]);
      if (item.product_id) {
        await connection.query('UPDATE products SET stock = stock + ? WHERE id = ?', [qty, item.product_id]);
      }
      item.returned_quantity += qty;
    }

    const remainingTotal = orderItems.reduce((sum, item) => sum + Number(item.price) * (item.quantity - item.returned_quantity), 0);
    const fullyReturned = orderItems.every((item) => item.returned_quantity >= item.quantity);
    const newStatus = fullyReturned ? 'return' : order.status;

    await connection.query('UPDATE orders SET total_amount = ?, status = ? WHERE id = ?', [remainingTotal, newStatus, id]);
    await connection.commit();
    res.json({ message: 'Return processed', total_amount: remainingTotal, status: newStatus });
  } catch (err) {
    await connection.rollback();
    console.error(err);
    res.status(500).json({ message: 'Failed to process return' });
  } finally {
    connection.release();
  }
}

module.exports = { placeOrder, listMyOrders, listAllOrders, updateOrderStatus, processReturn, createOrderRecord };
