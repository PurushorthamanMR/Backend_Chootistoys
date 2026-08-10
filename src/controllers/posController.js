const pool = require('../config/db');

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

    const [[{ cashSales }]] = await pool.query(
      `SELECT COALESCE(SUM(total_amount), 0) AS cashSales FROM sales
       WHERE shift_id = ? AND payment_method = 'cash' AND status = 'completed'`,
      [id]
    );
    const expectedCash = Number(shift.opening_cash) + Number(cashSales);

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
    const { items, customer_id, discount_amount, tax_percent, service_charge_percent } = req.body;
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ message: 'No items in this sale' });
    }

    const [[settingsRow]] = await pool.query(
      'SELECT pos_is_active, pos_tax_percent, pos_service_charge_percent FROM settings WHERE id = 1'
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
          Number(product.discount_percent) > 0 ? Number(product.discount_price) : Number(product.sale_price);
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

      const [saleResult] = await connection.query(
        `INSERT INTO sales (shift_id, staff_id, customer_id, subtotal, discount_amount, tax_percent, service_charge_percent, total_amount, payment_method, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'cash', 'completed')`,
        [shift.id, req.user.id, customer_id || null, subtotal, discount, taxPct, svcPct, total]
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

    const [items] = await connection.query('SELECT * FROM sale_items WHERE sale_id = ?', [id]);
    for (const item of items) {
      if (item.product_id) {
        await connection.query('UPDATE products SET stock = stock + ? WHERE id = ?', [
          item.quantity,
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
    res.json(rows);
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
    res.json({ ...sale, items });
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
      shifts,
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
  listSales,
  getSaleItems,
  getDailyReport,
  getStaffSalesReport,
  createHold,
  listHolds,
  deleteHold,
};
