const pool = require('../config/db');
const { reduceSaleReport } = require('../utils/reduceSaleReport');

const PAYMENT_METHODS = ['cash', 'card', 'cheque'];

async function loadReduceSaleSettings() {
  const [[row]] = await pool.query(
    'SELECT pos_reduce_sale_min, pos_reduce_sale_max FROM settings WHERE id = 1'
  );
  return {
    min: Number(row?.pos_reduce_sale_min) || 0,
    max: Number(row?.pos_reduce_sale_max) || 0,
  };
}

function wantsReduced(req) {
  const v = req.query.reduced;
  return v === '1' || v === 'true' || v === 'yes';
}

/**
 * Load completed sales + items + payments for a calendar day (optional staff filter).
 */
async function loadCompletedSalesForDate(date, staffId = null) {
  const params = staffId != null ? [date, staffId] : [date];
  const staffFilter = staffId != null ? 'AND s.staff_id = ?' : '';
  const [sales] = await pool.query(
    `SELECT s.*, u.name AS staff_name, c.name AS customer_name, DATE(s.created_at) AS date
     FROM sales s
     JOIN users u ON u.id = s.staff_id
     LEFT JOIN customers c ON c.id = s.customer_id
     WHERE DATE(s.created_at) = ? AND s.status = 'completed' ${staffFilter}
     ORDER BY s.id`,
    params
  );
  if (sales.length === 0) return [];

  const ids = sales.map((s) => s.id);
  const [items] = await pool.query(
    `SELECT id, sale_id, product_id, product_name, product_code, price, quantity, returned_quantity
     FROM sale_items WHERE sale_id IN (?)`,
    [ids]
  );
  const [payments] = await pool.query(
    `SELECT sale_id, method, amount FROM sale_payments WHERE sale_id IN (?)`,
    [ids]
  );

  const itemsBySale = new Map();
  for (const it of items) {
    if (!itemsBySale.has(it.sale_id)) itemsBySale.set(it.sale_id, []);
    itemsBySale.get(it.sale_id).push(it);
  }
  const paysBySale = new Map();
  for (const p of payments) {
    if (!paysBySale.has(p.sale_id)) paysBySale.set(p.sale_id, []);
    paysBySale.get(p.sale_id).push(p);
  }

  return sales.map((s) => ({
    ...s,
    date: s.date instanceof Date ? s.date.toISOString().slice(0, 10) : String(s.date).slice(0, 10),
    items: itemsBySale.get(s.id) || [],
    payments: paysBySale.get(s.id) || [],
  }));
}

/**
 * Load completed sales + items + payments for one shift.
 */
async function loadCompletedSalesForShift(shiftId) {
  const [sales] = await pool.query(
    `SELECT s.*, u.name AS staff_name, c.name AS customer_name, DATE(s.created_at) AS date
     FROM sales s
     JOIN users u ON u.id = s.staff_id
     LEFT JOIN customers c ON c.id = s.customer_id
     WHERE s.shift_id = ? AND s.status = 'completed'
     ORDER BY s.id`,
    [shiftId]
  );
  if (sales.length === 0) return [];

  const ids = sales.map((s) => s.id);
  const [items] = await pool.query(
    `SELECT id, sale_id, product_id, product_name, product_code, price, quantity, returned_quantity
     FROM sale_items WHERE sale_id IN (?)`,
    [ids]
  );
  const [payments] = await pool.query(
    `SELECT sale_id, method, amount FROM sale_payments WHERE sale_id IN (?)`,
    [ids]
  );

  const itemsBySale = new Map();
  for (const it of items) {
    if (!itemsBySale.has(it.sale_id)) itemsBySale.set(it.sale_id, []);
    itemsBySale.get(it.sale_id).push(it);
  }
  const paysBySale = new Map();
  for (const p of payments) {
    if (!paysBySale.has(p.sale_id)) paysBySale.set(p.sale_id, []);
    paysBySale.get(p.sale_id).push(p);
  }

  return sales.map((s) => ({
    ...s,
    date: s.date instanceof Date ? s.date.toISOString().slice(0, 10) : String(s.date).slice(0, 10),
    items: itemsBySale.get(s.id) || [],
    payments: paysBySale.get(s.id) || [],
  }));
}

function saleDateKey(value) {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

async function openShift(req, res) {
  try {
    const [[settingsRow]] = await pool.query('SELECT pos_is_active FROM settings WHERE id = 1');
    if (!settingsRow?.pos_is_active) {
      return res.status(403).json({ message: 'POS is currently disabled. Contact the store admin.' });
    }

    const { opening_cash } = req.body;
    if (opening_cash === undefined || Number(opening_cash) < 0 || Number.isNaN(Number(opening_cash))) {
      return res.status(400).json({ message: 'Enter a valid opening cash amount' });
    }

    const [[existing]] = await pool.query(
      `SELECT id FROM pos_shifts WHERE staff_id = ? AND status = 'open'`,
      [req.user.id]
    );
    if (existing) {
      return res.status(409).json({ message: 'You already have an open shift' });
    }

    const [result] = await pool.query('INSERT INTO pos_shifts (staff_id, opening_cash) VALUES (?, ?)', [
      req.user.id,
      opening_cash,
    ]);
    const [[shift]] = await pool.query('SELECT * FROM pos_shifts WHERE id = ?', [result.insertId]);
    res.status(201).json(shift);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Failed to open shift' });
  }
}

async function getCurrentShift(req, res) {
  try {
    const [[shift]] = await pool.query(
      `SELECT * FROM pos_shifts WHERE staff_id = ? AND status = 'open' ORDER BY opened_at DESC LIMIT 1`,
      [req.user.id]
    );
    res.json(shift || null);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Failed to fetch current shift' });
  }
}

async function closeShift(req, res) {
  try {
    const { id } = req.params;
    const { closing_cash } = req.body;
    if (closing_cash === undefined || Number(closing_cash) < 0 || Number.isNaN(Number(closing_cash))) {
      return res.status(400).json({ message: 'Enter a valid closing cash amount' });
    }

    const [[shift]] = await pool.query('SELECT * FROM pos_shifts WHERE id = ?', [id]);
    if (!shift) return res.status(404).json({ message: 'Shift not found' });
    if (shift.status !== 'open') return res.status(400).json({ message: 'Shift is already closed' });
    if (req.user.role === 'Staff' && shift.staff_id !== req.user.id) {
      return res.status(403).json({ message: 'You can only close your own shift' });
    }

    const [[{ cashCollected }]] = await pool.query(
      `SELECT COALESCE(SUM(sp.amount), 0) AS cashCollected FROM sale_payments sp
       JOIN sales s ON s.id = sp.sale_id
       WHERE sp.shift_id = ? AND sp.method = 'cash' AND s.status != 'voided'`,
      [id]
    );
    const expectedCash = Number(shift.opening_cash) + Number(cashCollected);

    await pool.query(
      `UPDATE pos_shifts SET closing_cash = ?, expected_cash = ?, closed_at = NOW(), status = 'closed' WHERE id = ?`,
      [closing_cash, expectedCash, id]
    );
    const [[updated]] = await pool.query('SELECT * FROM pos_shifts WHERE id = ?', [id]);
    res.json(updated);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Failed to close shift' });
  }
}

async function createSale(req, res) {
  try {
    const { items, customer_id, discount_amount, tax_percent, service_charge_percent, payment_method, amount_paid } = req.body;
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ message: 'No items in this sale' });
    }
    const paymentMethod = payment_method || 'cash';
    if (!PAYMENT_METHODS.includes(paymentMethod)) {
      return res.status(400).json({ message: 'Invalid payment method' });
    }

    const [[settingsRow]] = await pool.query(
      'SELECT pos_is_active, pos_tax_percent, pos_service_charge_percent, pos_display_price FROM settings WHERE id = 1'
    );
    if (!settingsRow?.pos_is_active) {
      return res.status(403).json({ message: 'POS is currently disabled' });
    }

    const [[shift]] = await pool.query(`SELECT id FROM pos_shifts WHERE staff_id = ? AND status = 'open'`, [
      req.user.id,
    ]);
    if (!shift) {
      return res.status(400).json({ message: 'Open a shift before taking a sale' });
    }

    const priceMode = settingsRow.pos_display_price === 'cost' ? 'cost' : 'sale';

    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();

      let subtotal = 0;
      const lineItems = [];
      for (const item of items) {
        const qty = Number(item.quantity);
        if (!item.product_id || !qty || qty <= 0) {
          await connection.rollback();
          return res.status(400).json({ message: 'Invalid item in sale' });
        }
        const [[product]] = await connection.query('SELECT * FROM products WHERE id = ? FOR UPDATE', [
          item.product_id,
        ]);
        if (!product || product.stock < qty) {
          await connection.rollback();
          return res.status(400).json({ message: `Not enough stock for ${product?.name || 'this product'}` });
        }
        const unitPrice =
          priceMode === 'cost'
            ? Number(product.purchase_price) || 0
            : Number(product.discount_percent) > 0
              ? Number(product.discount_price)
              : Number(product.sale_price);
        subtotal += unitPrice * qty;
        lineItems.push({
          product_id: product.id,
          product_name: product.name,
          product_code: product.product_code,
          price: unitPrice,
          quantity: qty,
        });
      }

      const discount = Number(discount_amount) || 0;
      const taxPct =
        tax_percent !== undefined && tax_percent !== null && tax_percent !== ''
          ? Number(tax_percent)
          : Number(settingsRow.pos_tax_percent);
      const svcPct =
        service_charge_percent !== undefined && service_charge_percent !== null && service_charge_percent !== ''
          ? Number(service_charge_percent)
          : Number(settingsRow.pos_service_charge_percent);
      const afterDiscount = Math.max(0, subtotal - discount);
      const taxAmount = afterDiscount * (taxPct / 100);
      const svcAmount = afterDiscount * (svcPct / 100);
      const total = afterDiscount + taxAmount + svcAmount;

      let amountPaid = amount_paid !== undefined && amount_paid !== null && amount_paid !== '' ? Number(amount_paid) : total;
      if (!Number.isFinite(amountPaid) || amountPaid < 0) amountPaid = total;
      amountPaid = Math.min(amountPaid, total);
      const balanceDue = total - amountPaid;

      const [saleResult] = await connection.query(
        `INSERT INTO sales (shift_id, staff_id, customer_id, subtotal, discount_amount, tax_percent, service_charge_percent, total_amount, amount_paid, balance_due, payment_method, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'completed')`,
        [shift.id, req.user.id, customer_id || null, subtotal, discount, taxPct, svcPct, total, amountPaid, balanceDue, paymentMethod]
      );

      for (const item of lineItems) {
        await connection.query(
          `INSERT INTO sale_items (sale_id, product_id, product_name, product_code, price, quantity) VALUES (?, ?, ?, ?, ?, ?)`,
          [saleResult.insertId, item.product_id, item.product_name, item.product_code, item.price, item.quantity]
        );
        await connection.query('UPDATE products SET stock = stock - ? WHERE id = ?', [
          item.quantity,
          item.product_id,
        ]);
      }

      if (amountPaid > 0) {
        await connection.query(
          `INSERT INTO sale_payments (sale_id, shift_id, staff_id, amount, method) VALUES (?, ?, ?, ?, ?)`,
          [saleResult.insertId, shift.id, req.user.id, amountPaid, paymentMethod]
        );
      }

      await connection.commit();
      const [[sale]] = await pool.query('SELECT * FROM sales WHERE id = ?', [saleResult.insertId]);
      const [saleItems] = await pool.query('SELECT * FROM sale_items WHERE sale_id = ?', [saleResult.insertId]);
      res.status(201).json({ ...sale, items: saleItems });
    } catch (err) {
      await connection.rollback();
      throw err;
    } finally {
      connection.release();
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Failed to complete sale' });
  }
}

async function voidSale(req, res) {
  const { id } = req.params;
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const [[sale]] = await connection.query('SELECT * FROM sales WHERE id = ? FOR UPDATE', [id]);
    if (!sale) {
      await connection.rollback();
      return res.status(404).json({ message: 'Sale not found' });
    }
    if (sale.status === 'voided') {
      await connection.rollback();
      return res.status(400).json({ message: 'Sale is already voided' });
    }
    if (sale.status === 'returned') {
      await connection.rollback();
      return res.status(400).json({ message: 'Sale is already returned' });
    }

    const [items] = await connection.query('SELECT * FROM sale_items WHERE sale_id = ?', [id]);
    for (const item of items) {
      // Only restore what hasn't already been handed back via a partial return -
      // otherwise a void-after-partial-return would double-credit stock.
      const outstanding = item.quantity - item.returned_quantity;
      if (item.product_id && outstanding > 0) {
        await connection.query('UPDATE products SET stock = stock + ? WHERE id = ?', [
          outstanding,
          item.product_id,
        ]);
      }
    }

    await connection.query(`UPDATE sales SET status = 'voided', voided_at = NOW(), voided_by = ? WHERE id = ?`, [
      req.user.id,
      id,
    ]);
    await connection.commit();
    res.json({ message: 'Sale voided' });
  } catch (err) {
    await connection.rollback();
    console.error(err);
    res.status(500).json({ message: 'Failed to void sale' });
  } finally {
    connection.release();
  }
}

async function addSalePayment(req, res) {
  const { id } = req.params;
  const { amount, payment_method } = req.body;
  const paymentAmount = Number(amount);
  if (!Number.isFinite(paymentAmount) || paymentAmount <= 0) {
    return res.status(400).json({ message: 'Enter a valid payment amount' });
  }
  if (!PAYMENT_METHODS.includes(payment_method)) {
    return res.status(400).json({ message: 'Invalid payment method' });
  }

  const [[shift]] = await pool.query(`SELECT id FROM pos_shifts WHERE staff_id = ? AND status = 'open'`, [
    req.user.id,
  ]);
  if (!shift) {
    return res.status(400).json({ message: 'Open a shift before recording a payment' });
  }

  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const [[sale]] = await connection.query('SELECT * FROM sales WHERE id = ? FOR UPDATE', [id]);
    if (!sale) {
      await connection.rollback();
      return res.status(404).json({ message: 'Sale not found' });
    }
    if (sale.status !== 'completed') {
      await connection.rollback();
      return res.status(400).json({ message: 'Only completed sales can take a payment' });
    }
    if (paymentAmount > Number(sale.balance_due)) {
      await connection.rollback();
      return res.status(400).json({ message: `Cannot pay more than the balance due (${sale.balance_due})` });
    }

    await connection.query(
      `UPDATE sales SET amount_paid = amount_paid + ?, balance_due = balance_due - ? WHERE id = ?`,
      [paymentAmount, paymentAmount, id]
    );
    await connection.query(
      `INSERT INTO sale_payments (sale_id, shift_id, staff_id, amount, method) VALUES (?, ?, ?, ?, ?)`,
      [id, shift.id, req.user.id, paymentAmount, payment_method]
    );

    await connection.commit();
    const [[updated]] = await pool.query('SELECT * FROM sales WHERE id = ?', [id]);
    res.json(updated);
  } catch (err) {
    await connection.rollback();
    console.error(err);
    res.status(500).json({ message: 'Failed to record payment' });
  } finally {
    connection.release();
  }
}

async function processSaleReturn(req, res) {
  const { id } = req.params;
  const { items } = req.body;
  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ message: 'No return quantities provided' });
  }

  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    const [[sale]] = await connection.query('SELECT * FROM sales WHERE id = ? FOR UPDATE', [id]);
    if (!sale) {
      await connection.rollback();
      return res.status(404).json({ message: 'Sale not found' });
    }
    if (sale.status !== 'completed') {
      await connection.rollback();
      return res.status(400).json({ message: 'Only completed sales can be returned' });
    }

    const [saleItems] = await connection.query('SELECT * FROM sale_items WHERE sale_id = ? FOR UPDATE', [id]);
    const itemMap = new Map(saleItems.map((si) => [si.id, si]));

    let returnedValue = 0;
    for (const req_item of items) {
      const qty = Number(req_item.quantity) || 0;
      if (qty <= 0) continue;
      const item = itemMap.get(Number(req_item.id));
      if (!item) {
        await connection.rollback();
        return res.status(400).json({ message: 'Invalid sale item' });
      }
      const remaining = item.quantity - item.returned_quantity;
      if (qty > remaining) {
        await connection.rollback();
        return res.status(400).json({ message: `Cannot return more than ${remaining} of ${item.product_name}` });
      }

      await connection.query('UPDATE sale_items SET returned_quantity = returned_quantity + ? WHERE id = ?', [qty, item.id]);
      if (item.product_id) {
        await connection.query('UPDATE products SET stock = stock + ? WHERE id = ?', [qty, item.product_id]);
      }
      returnedValue += Number(item.price) * qty;
      item.returned_quantity += qty;
    }

    // sales.total_amount bakes discount/tax/service-charge on top of subtotal, so a returned
    // line's dollar impact isn't just price*qty - scale it by the sale's current total/subtotal
    // ratio. That ratio is invariant across successive partial returns (both shrink by the same
    // factor each time), so recomputing it fresh from the row each call stays exact, no drift.
    const ratio = Number(sale.subtotal) > 0 ? Number(sale.total_amount) / Number(sale.subtotal) : 0;
    const newSubtotal = Number(sale.subtotal) - returnedValue;
    const newTotal = Number(sale.total_amount) - returnedValue * ratio;
    const newBalanceDue = newTotal - Number(sale.amount_paid);
    const fullyReturned = [...itemMap.values()].every((item) => item.returned_quantity >= item.quantity);
    const newStatus = fullyReturned ? 'returned' : sale.status;

    await connection.query(
      `UPDATE sales SET subtotal = ?, total_amount = ?, balance_due = ?, status = ? WHERE id = ?`,
      [newSubtotal, newTotal, newBalanceDue, newStatus, id]
    );
    await connection.commit();
    res.json({ message: 'Return processed', total_amount: newTotal, balance_due: newBalanceDue, status: newStatus });
  } catch (err) {
    await connection.rollback();
    console.error(err);
    res.status(500).json({ message: 'Failed to process return' });
  } finally {
    connection.release();
  }
}

async function listSales(req, res) {
  try {
    const { from, to, staff_id, shift_id } = req.query;
    const where = [];
    const params = [];

    if (req.user.role === 'Staff') {
      where.push('s.staff_id = ?');
      params.push(req.user.id);
    } else if (staff_id) {
      where.push('s.staff_id = ?');
      params.push(staff_id);
    }
    if (shift_id) {
      where.push('s.shift_id = ?');
      params.push(shift_id);
    }
    if (from) {
      where.push('s.created_at >= ?');
      params.push(from);
    }
    if (to) {
      where.push('s.created_at <= ?');
      params.push(to);
    }

    const [rows] = await pool.query(
      `SELECT s.*, u.name AS staff_name, c.name AS customer_name
       FROM sales s
       JOIN users u ON u.id = s.staff_id
       LEFT JOIN customers c ON c.id = s.customer_id
       ${where.length > 0 ? 'WHERE ' + where.join(' AND ') : ''}
       ORDER BY s.created_at DESC
       LIMIT 200`,
      params
    );

    if (!wantsReduced(req)) {
      return res.json(rows);
    }

    const { min, max } = await loadReduceSaleSettings();
    if (max <= 0 || min < 0 || min > max) {
      return res.json(rows);
    }

    const isStaffOnly = req.user.role === 'Staff';
    const staffScopeId = isStaffOnly ? req.user.id : null;
    const nonCompleted = rows.filter((r) => r.status !== 'completed');
    const completedInList = rows.filter((r) => r.status === 'completed');
    if (completedInList.length === 0) {
      return res.json(rows);
    }

    // Reduce each calendar day with the same scopeKey as Z-Report so totals match.
    const dates = [...new Set(completedInList.map((r) => saleDateKey(r.created_at)))];
    const reducedById = new Map();
    for (const date of dates) {
      const loaded = await loadCompletedSalesForDate(date, staffScopeId);
      const result = reduceSaleReport({
        scopeKey: `z:${date}:${staffScopeId != null ? staffScopeId : 'all'}`,
        min,
        max,
        sales: loaded,
      });
      for (const sale of result.sales) {
        reducedById.set(sale.id, sale);
      }
    }

    const reducedCompleted = completedInList
      .map((row) => {
        const reduced = reducedById.get(row.id);
        if (!reduced) return null; // dropped by reducer
        const { items, payments, date, ...money } = reduced;
        return {
          ...row,
          subtotal: money.subtotal,
          discount_amount: money.discount_amount,
          total_amount: money.total_amount,
          amount_paid: money.amount_paid,
          balance_due: money.balance_due,
          payment_method: money.payment_method || row.payment_method,
        };
      })
      .filter(Boolean);

    const merged = [...reducedCompleted, ...nonCompleted].sort(
      (a, b) => new Date(b.created_at) - new Date(a.created_at)
    );
    res.json(merged);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Failed to fetch sales' });
  }
}

async function getSaleItems(req, res) {
  try {
    const { id } = req.params;
    const [[sale]] = await pool.query(
      `SELECT s.*, u.name AS staff_name, c.name AS customer_name
       FROM sales s JOIN users u ON u.id = s.staff_id LEFT JOIN customers c ON c.id = s.customer_id
       WHERE s.id = ?`,
      [id]
    );
    if (!sale) return res.status(404).json({ message: 'Sale not found' });
    if (req.user.role === 'Staff' && sale.staff_id !== req.user.id) {
      return res.status(403).json({ message: 'Not your sale' });
    }
    const [items] = await pool.query('SELECT * FROM sale_items WHERE sale_id = ?', [id]);

    if (!wantsReduced(req) || sale.status !== 'completed') {
      return res.json({ ...sale, items });
    }

    const { min, max } = await loadReduceSaleSettings();
    if (max <= 0 || min < 0 || min > max) {
      return res.json({ ...sale, items });
    }

    const isStaffOnly = req.user.role === 'Staff';
    const staffScopeId = isStaffOnly ? req.user.id : null;
    const date = saleDateKey(sale.created_at);
    const loaded = await loadCompletedSalesForDate(date, staffScopeId);
    const result = reduceSaleReport({
      scopeKey: `z:${date}:${staffScopeId != null ? staffScopeId : 'all'}`,
      min,
      max,
      sales: loaded,
    });
    const reduced = result.sales.find((s) => Number(s.id) === Number(id));
    if (!reduced) {
      return res.status(404).json({ message: 'Sale not visible in Reduce Sale view' });
    }

    res.json({
      ...sale,
      subtotal: reduced.subtotal,
      discount_amount: reduced.discount_amount,
      total_amount: reduced.total_amount,
      amount_paid: reduced.amount_paid,
      balance_due: reduced.balance_due,
      payment_method: reduced.payment_method || sale.payment_method,
      items: reduced.items || [],
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Failed to fetch sale' });
  }
}

async function getDailyReport(req, res) {
  try {
    const date = req.query.date || new Date().toISOString().slice(0, 10);
    const isStaffOnly = req.user.role === 'Staff';
    const salesParams = isStaffOnly ? [date, req.user.id] : [date];
    const staffFilter = isStaffOnly ? 'AND s.staff_id = ?' : '';
    const reduce = wantsReduced(req);

    if (reduce) {
      const { min, max } = await loadReduceSaleSettings();
      const loaded = await loadCompletedSalesForDate(date, isStaffOnly ? req.user.id : null);
      const result = reduceSaleReport({
        scopeKey: `z:${date}:${isStaffOnly ? req.user.id : 'all'}`,
        min,
        max,
        sales: loaded,
      });

      const [[voided]] = await pool.query(
        `SELECT COUNT(*) AS voidedCount FROM sales s WHERE DATE(s.created_at) = ? AND s.status = 'voided' ${staffFilter}`,
        salesParams
      );
      const [[returned]] = await pool.query(
        `SELECT COUNT(*) AS returnedCount FROM sales s WHERE DATE(s.created_at) = ? AND s.status = 'returned' ${staffFilter}`,
        salesParams
      );
      const shiftParams = isStaffOnly ? [date, req.user.id] : [date];
      const [shifts] = await pool.query(
        `SELECT ps.*, u.name AS staff_name FROM pos_shifts ps JOIN users u ON u.id = ps.staff_id
         WHERE DATE(ps.opened_at) = ? ${isStaffOnly ? 'AND ps.staff_id = ?' : ''}
         ORDER BY ps.opened_at DESC`,
        shiftParams
      );

      return res.json({
        date,
        transactionCount: result.aggregates.transactionCount,
        totalSales: result.aggregates.totalSales,
        totalDiscount: result.aggregates.totalDiscount,
        voidedCount: voided.voidedCount,
        returnedCount: returned.returnedCount,
        totalBalanceDue: result.aggregates.totalBalanceDue,
        paymentBreakdown: result.aggregates.paymentBreakdown,
        shifts,
        reduced: result.applied,
        targetTotal: result.targetTotal,
      });
    }

    const [[totals]] = await pool.query(
      `SELECT COUNT(*) AS transactionCount,
              COALESCE(SUM(total_amount), 0) AS totalSales,
              COALESCE(SUM(discount_amount), 0) AS totalDiscount
       FROM sales s
       WHERE DATE(s.created_at) = ? AND s.status = 'completed' ${staffFilter}`,
      salesParams
    );

    const [[voided]] = await pool.query(
      `SELECT COUNT(*) AS voidedCount FROM sales s WHERE DATE(s.created_at) = ? AND s.status = 'voided' ${staffFilter}`,
      salesParams
    );

    const [[returned]] = await pool.query(
      `SELECT COUNT(*) AS returnedCount FROM sales s WHERE DATE(s.created_at) = ? AND s.status = 'returned' ${staffFilter}`,
      salesParams
    );

    const [[{ totalBalanceDue }]] = await pool.query(
      `SELECT COALESCE(SUM(balance_due), 0) AS totalBalanceDue FROM sales s
       WHERE DATE(s.created_at) = ? AND s.status = 'completed' ${staffFilter}`,
      salesParams
    );

    const [paymentBreakdown] = await pool.query(
      `SELECT sp.method, COALESCE(SUM(sp.amount), 0) AS total
       FROM sale_payments sp JOIN sales s ON s.id = sp.sale_id
       WHERE DATE(sp.created_at) = ? AND s.status != 'voided' ${staffFilter}
       GROUP BY sp.method`,
      salesParams
    );

    const shiftParams = isStaffOnly ? [date, req.user.id] : [date];
    const [shifts] = await pool.query(
      `SELECT ps.*, u.name AS staff_name FROM pos_shifts ps JOIN users u ON u.id = ps.staff_id
       WHERE DATE(ps.opened_at) = ? ${isStaffOnly ? 'AND ps.staff_id = ?' : ''}
       ORDER BY ps.opened_at DESC`,
      shiftParams
    );

    res.json({
      date,
      transactionCount: totals.transactionCount,
      totalSales: Number(totals.totalSales),
      totalDiscount: Number(totals.totalDiscount),
      voidedCount: voided.voidedCount,
      returnedCount: returned.returnedCount,
      totalBalanceDue: Number(totalBalanceDue),
      paymentBreakdown: paymentBreakdown.map((row) => ({ method: row.method, total: Number(row.total) })),
      shifts,
      reduced: false,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Failed to fetch daily report' });
  }
}

// Per-staff, per-day sales breakdown - Admin/SuperAdmin only (a cashier
// doesn't need visibility into other staff's numbers, same reasoning as
// listSales scoping Staff callers to their own rows). Defaults to a single
// day (today) but accepts a wider from/to range for a multi-day view.
async function getStaffSalesReport(req, res) {
  try {
    const to = req.query.to || new Date().toISOString().slice(0, 10);
    const from = req.query.from || to;
    const reduce = wantsReduced(req);

    if (reduce) {
      const { min, max } = await loadReduceSaleSettings();
      // Staff breakdown is usually a single day (Z-Report). Reduce per day so
      // each day's target stays stable, then merge rows.
      const days = [];
      const cursor = new Date(`${from}T00:00:00`);
      const end = new Date(`${to}T00:00:00`);
      while (cursor <= end) {
        days.push(cursor.toISOString().slice(0, 10));
        cursor.setDate(cursor.getDate() + 1);
      }

      const merged = new Map();
      for (const day of days) {
        const loaded = await loadCompletedSalesForDate(day, null);
        const result = reduceSaleReport({
          scopeKey: `z:${day}:all`,
          min,
          max,
          sales: loaded,
        });
        for (const row of result.staffSales) {
          const key = `${row.date}|${row.staff_id}`;
          if (!merged.has(key)) {
            merged.set(key, { ...row });
          } else {
            const m = merged.get(key);
            m.transactionCount += row.transactionCount;
            m.totalSales = Number((m.totalSales + row.totalSales).toFixed(2));
            m.totalDiscount = Number((m.totalDiscount + row.totalDiscount).toFixed(2));
          }
        }
      }

      return res.json(
        [...merged.values()].sort((a, b) => {
          if (a.date === b.date) return b.totalSales - a.totalSales;
          return a.date < b.date ? 1 : -1;
        })
      );
    }

    const [rows] = await pool.query(
      `SELECT DATE(s.created_at) AS date, u.id AS staff_id, u.name AS staff_name,
              COUNT(*) AS transactionCount,
              COALESCE(SUM(s.total_amount), 0) AS totalSales,
              COALESCE(SUM(s.discount_amount), 0) AS totalDiscount
       FROM sales s
       JOIN users u ON u.id = s.staff_id
       WHERE s.status = 'completed' AND DATE(s.created_at) BETWEEN ? AND ?
       GROUP BY DATE(s.created_at), u.id, u.name
       ORDER BY date DESC, totalSales DESC`,
      [from, to]
    );

    res.json(
      rows.map((r) => ({
        ...r,
        totalSales: Number(r.totalSales),
        totalDiscount: Number(r.totalDiscount),
      }))
    );
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Failed to fetch staff sales report' });
  }
}

// Live snapshot of the currently OPEN shift(s) - unlike getDailyReport (a closed-book,
// end-of-day Z-Report), this is a pure read callable any time mid-shift with no side effects.
// Staff only ever sees their own open shift; Admin/SuperAdmin see every open shift.
async function getXReport(req, res) {
  try {
    const isStaffOnly = req.user.role === 'Staff';
    const reduce = wantsReduced(req);
    const reduceSettings = reduce ? await loadReduceSaleSettings() : null;

    const [shifts] = await pool.query(
      `SELECT ps.*, u.name AS staff_name FROM pos_shifts ps JOIN users u ON u.id = ps.staff_id
       WHERE ps.status = 'open' ${isStaffOnly ? 'AND ps.staff_id = ?' : ''}
       ORDER BY ps.opened_at DESC`,
      isStaffOnly ? [req.user.id] : []
    );

    const report = [];
    for (const shift of shifts) {
      if (reduce) {
        const loaded = await loadCompletedSalesForShift(shift.id);
        const result = reduceSaleReport({
          scopeKey: `x:${shift.id}`,
          min: reduceSettings.min,
          max: reduceSettings.max,
          sales: loaded,
        });
        report.push({
          shift,
          transactionCount: result.aggregates.transactionCount,
          totalSales: result.aggregates.totalSales,
          totalDiscount: result.aggregates.totalDiscount,
          totalBalanceDue: result.aggregates.totalBalanceDue,
          paymentBreakdown: result.aggregates.paymentBreakdown,
          expectedCash: Number(shift.opening_cash) + result.aggregates.cashCollected,
          reduced: result.applied,
          targetTotal: result.targetTotal,
        });
        continue;
      }

      const [[totals]] = await pool.query(
        `SELECT COUNT(*) AS transactionCount,
                COALESCE(SUM(total_amount), 0) AS totalSales,
                COALESCE(SUM(discount_amount), 0) AS totalDiscount
         FROM sales WHERE shift_id = ? AND status = 'completed'`,
        [shift.id]
      );
      const [[{ totalBalanceDue }]] = await pool.query(
        `SELECT COALESCE(SUM(balance_due), 0) AS totalBalanceDue FROM sales
         WHERE shift_id = ? AND status = 'completed'`,
        [shift.id]
      );
      const [paymentBreakdown] = await pool.query(
        `SELECT sp.method, COALESCE(SUM(sp.amount), 0) AS total
         FROM sale_payments sp JOIN sales s ON s.id = sp.sale_id
         WHERE sp.shift_id = ? AND s.status != 'voided' GROUP BY sp.method`,
        [shift.id]
      );
      const [[{ cashCollected }]] = await pool.query(
        `SELECT COALESCE(SUM(sp.amount), 0) AS cashCollected FROM sale_payments sp
         JOIN sales s ON s.id = sp.sale_id
         WHERE sp.shift_id = ? AND sp.method = 'cash' AND s.status != 'voided'`,
        [shift.id]
      );

      report.push({
        shift,
        transactionCount: totals.transactionCount,
        totalSales: Number(totals.totalSales),
        totalDiscount: Number(totals.totalDiscount),
        totalBalanceDue: Number(totalBalanceDue),
        paymentBreakdown: paymentBreakdown.map((row) => ({ method: row.method, total: Number(row.total) })),
        expectedCash: Number(shift.opening_cash) + Number(cashCollected),
        reduced: false,
      });
    }

    res.json({ generatedAt: new Date().toISOString(), shifts: report });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Failed to fetch X-report' });
  }
}

async function createHold(req, res) {
  try {
    const { items, customer_id, note } = req.body;
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ message: 'Nothing to hold' });
    }
    const [result] = await pool.query('INSERT INTO pos_holds (staff_id, customer_id, items, note) VALUES (?, ?, ?, ?)', [
      req.user.id,
      customer_id || null,
      JSON.stringify(items),
      note || null,
    ]);
    const [[hold]] = await pool.query('SELECT * FROM pos_holds WHERE id = ?', [result.insertId]);
    res.status(201).json(hold);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Failed to hold order' });
  }
}

async function listHolds(req, res) {
  try {
    const [rows] = await pool.query(
      `SELECT ph.*, c.name AS customer_name FROM pos_holds ph LEFT JOIN customers c ON c.id = ph.customer_id
       WHERE ph.staff_id = ? ORDER BY ph.created_at DESC`,
      [req.user.id]
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Failed to fetch held orders' });
  }
}

async function deleteHold(req, res) {
  try {
    const { id } = req.params;
    const [[hold]] = await pool.query('SELECT id FROM pos_holds WHERE id = ? AND staff_id = ?', [id, req.user.id]);
    if (!hold) return res.status(404).json({ message: 'Held order not found' });
    await pool.query('DELETE FROM pos_holds WHERE id = ?', [id]);
    res.json({ message: 'Held order removed' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Failed to remove held order' });
  }
}

module.exports = {
  openShift,
  getCurrentShift,
  closeShift,
  createSale,
  voidSale,
  addSalePayment,
  processSaleReturn,
  listSales,
  getSaleItems,
  getDailyReport,
  getStaffSalesReport,
  getXReport,
  createHold,
  listHolds,
  deleteHold,
};
