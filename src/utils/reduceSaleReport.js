/**
 * Display-only Reduce Sale helper for X/Z reports and Sales History.
 * Never mutates the database — callers pass in-memory sale/item/payment rows
 * and get back quantity-reduced aggregates that stay mathematically consistent.
 */

function round2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

/** Deterministic 0..1 float from a string seed (stable across refreshes). */
function seededUnit(scopeKey) {
  let h = 2166136261;
  const s = String(scopeKey);
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  // unsigned 32-bit → [0, 1)
  return (h >>> 0) / 4294967296;
}

function pickTarget(scopeKey, min, max) {
  const lo = round2(min);
  const hi = round2(max);
  if (hi <= lo) return lo;
  const t = lo + seededUnit(scopeKey) * (hi - lo);
  return round2(t);
}

function saleRatio(sale) {
  const sub = Number(sale.subtotal) || 0;
  if (sub <= 0) return 0;
  return Number(sale.total_amount) / sub;
}

function netQty(item) {
  return Math.max(0, Number(item.quantity) - Number(item.returned_quantity || 0));
}

function mapDisplayItems(items) {
  return (items || [])
    .map((it) => ({
      id: it.id,
      product_id: it.product_id,
      product_name: it.product_name,
      product_code: it.product_code,
      price: Number(it.price) || 0,
      quantity: Number(it.quantity) || 0,
      returned_quantity: Number(it.returned_quantity) || 0,
    }))
    .filter((it) => it.quantity > 0);
}

/**
 * Build working sale copies with mutable line quantities.
 * @returns {{ sales: object[], realTotal: number }}
 */
function cloneWorkingSales(sales) {
  const working = sales.map((sale) => {
    const items = (sale.items || []).map((it) => ({
      id: it.id,
      product_id: it.product_id,
      product_name: it.product_name,
      product_code: it.product_code,
      price: Number(it.price) || 0,
      qty: netQty(it),
    }));
    const netSubtotal = items.reduce((s, it) => s + it.price * it.qty, 0);
    return {
      id: sale.id,
      staff_id: sale.staff_id,
      staff_name: sale.staff_name,
      customer_name: sale.customer_name,
      created_at: sale.created_at,
      status: sale.status,
      payment_method: sale.payment_method,
      tax_percent: sale.tax_percent,
      service_charge_percent: sale.service_charge_percent,
      shift_id: sale.shift_id,
      customer_id: sale.customer_id,
      date: sale.date,
      subtotal: Number(sale.subtotal) || 0,
      discount_amount: Number(sale.discount_amount) || 0,
      total_amount: Number(sale.total_amount) || 0,
      balance_due: Number(sale.balance_due) || 0,
      amount_paid: Number(sale.amount_paid) || 0,
      ratio: saleRatio(sale),
      items,
      // Prefer summing from item nets when they match; fall back to sale.subtotal.
      netSubtotal: netSubtotal > 0 ? netSubtotal : Number(sale.subtotal) || 0,
      payments: (sale.payments || []).map((p) => ({
        method: p.method,
        amount: Number(p.amount) || 0,
      })),
    };
  });
  const realTotal = round2(working.reduce((s, sale) => s + sale.total_amount, 0));
  return { sales: working, realTotal };
}

function currentMerchandise(sale) {
  return sale.items.reduce((s, it) => s + it.price * it.qty, 0);
}

function currentSaleTotal(sale) {
  const merch = currentMerchandise(sale);
  if (sale.netSubtotal <= 0) return 0;
  // Keep original bill ratio so tax/discount/svc stay proportional.
  const removed = sale.netSubtotal - merch;
  return round2(sale.total_amount - removed * sale.ratio);
}

function sumWorkingTotal(sales) {
  return round2(sales.reduce((s, sale) => s + currentSaleTotal(sale), 0));
}

/**
 * Drop whole units from largest-value lines until totals sit near target (>= min).
 */
function reduceQuantities(sales, target, min) {
  // Safety bound: never more iterations than total units.
  const maxUnits = sales.reduce(
    (n, sale) => n + sale.items.reduce((m, it) => m + it.qty, 0),
    0
  );
  for (let step = 0; step < maxUnits + 5; step += 1) {
    const current = sumWorkingTotal(sales);
    if (current <= target) break;

    let best = null;
    for (let si = 0; si < sales.length; si += 1) {
      const sale = sales[si];
      for (let ii = 0; ii < sale.items.length; ii += 1) {
        const it = sale.items[ii];
        if (it.qty <= 0) continue;
        const unitBill = round2(it.price * sale.ratio);
        if (unitBill <= 0) continue;
        const after = round2(current - unitBill);
        // Prefer staying >= target; otherwise stay >= min and closest to target.
        const ok = after >= min || after >= target;
        if (!ok && after < min) continue;
        const overshoot = after > target ? after - target : target - after;
        const preferAbove = after >= target ? 0 : 1;
        if (
          !best ||
          preferAbove < best.preferAbove ||
          (preferAbove === best.preferAbove && overshoot < best.overshoot) ||
          (preferAbove === best.preferAbove &&
            overshoot === best.overshoot &&
            unitBill > best.unitBill)
        ) {
          best = { si, ii, unitBill, after, overshoot, preferAbove };
        }
      }
    }

    if (!best) {
      // No unit can be removed without going below min — stop.
      break;
    }
    sales[best.si].items[best.ii].qty -= 1;
  }
}

function scalePayments(payments, newTotal, oldTotal) {
  if (!payments.length) return [];
  if (oldTotal <= 0 || newTotal <= 0) {
    return payments.map((p) => ({ method: p.method, amount: 0 }));
  }
  const factor = newTotal / oldTotal;
  const scaled = payments.map((p) => ({
    method: p.method,
    amount: round2(p.amount * factor),
  }));
  const sum = round2(scaled.reduce((s, p) => s + p.amount, 0));
  let residual = round2(newTotal - sum);
  if (residual !== 0 && scaled.length) {
    // Put leftover cents on the largest payment method.
    let idx = 0;
    for (let i = 1; i < scaled.length; i += 1) {
      if (scaled[i].amount > scaled[idx].amount) idx = i;
    }
    scaled[idx].amount = round2(scaled[idx].amount + residual);
  }
  return scaled;
}

function finalizeSales(workingSales) {
  return workingSales
    .map((sale) => {
      const merch = currentMerchandise(sale);
      if (merch <= 0 && sale.items.every((it) => it.qty <= 0)) {
        return null; // fully dropped from reduced view
      }
      const removed = sale.netSubtotal - merch;
      const newSubtotal = round2(Math.max(0, sale.subtotal - removed));
      const newTotal = currentSaleTotal(sale);
      const discountFactor = sale.subtotal > 0 ? newSubtotal / sale.subtotal : 0;
      const newDiscount = round2(sale.discount_amount * discountFactor);
      const payments = scalePayments(sale.payments, newTotal, sale.total_amount);
      const amountPaid = round2(payments.reduce((s, p) => s + p.amount, 0));
      const balanceDue = round2(Math.max(0, newTotal - amountPaid));
      const items = sale.items
        .filter((it) => it.qty > 0)
        .map((it) => ({
          id: it.id,
          product_id: it.product_id,
          product_name: it.product_name,
          product_code: it.product_code,
          price: it.price,
          quantity: it.qty,
          returned_quantity: 0,
        }));
      const primaryMethod =
        payments.slice().sort((a, b) => b.amount - a.amount)[0]?.method || sale.payment_method || 'cash';
      return {
        id: sale.id,
        staff_id: sale.staff_id,
        staff_name: sale.staff_name,
        customer_name: sale.customer_name,
        created_at: sale.created_at,
        status: sale.status || 'completed',
        payment_method: primaryMethod,
        tax_percent: sale.tax_percent,
        service_charge_percent: sale.service_charge_percent,
        shift_id: sale.shift_id,
        customer_id: sale.customer_id,
        date: sale.date,
        subtotal: newSubtotal,
        discount_amount: newDiscount,
        total_amount: newTotal,
        amount_paid: amountPaid,
        balance_due: balanceDue,
        payments,
        items,
      };
    })
    .filter(Boolean);
}

function buildAggregates(finalSales) {
  const totalSales = round2(finalSales.reduce((s, sale) => s + sale.total_amount, 0));
  const totalDiscount = round2(finalSales.reduce((s, sale) => s + sale.discount_amount, 0));
  const totalBalanceDue = round2(finalSales.reduce((s, sale) => s + sale.balance_due, 0));
  const transactionCount = finalSales.length;

  const byMethod = new Map();
  for (const sale of finalSales) {
    for (const p of sale.payments) {
      byMethod.set(p.method, round2((byMethod.get(p.method) || 0) + p.amount));
    }
  }
  const paymentBreakdown = [...byMethod.entries()].map(([method, total]) => ({ method, total }));
  // Fix residual so payment methods sum exactly to totalSales.
  const paySum = round2(paymentBreakdown.reduce((s, r) => s + r.total, 0));
  let residual = round2(totalSales - paySum);
  if (residual !== 0 && paymentBreakdown.length) {
    let idx = 0;
    for (let i = 1; i < paymentBreakdown.length; i += 1) {
      if (paymentBreakdown[i].total > paymentBreakdown[idx].total) idx = i;
    }
    paymentBreakdown[idx].total = round2(paymentBreakdown[idx].total + residual);
  }

  const cashCollected = round2(
    paymentBreakdown.filter((r) => r.method === 'cash').reduce((s, r) => s + r.total, 0)
  );

  return {
    totalSales,
    totalDiscount,
    transactionCount,
    totalBalanceDue,
    paymentBreakdown,
    cashCollected,
  };
}

function buildStaffSales(finalSales) {
  const map = new Map();
  for (const sale of finalSales) {
    const key = `${sale.date || ''}|${sale.staff_id}`;
    if (!map.has(key)) {
      map.set(key, {
        date: sale.date,
        staff_id: sale.staff_id,
        staff_name: sale.staff_name,
        transactionCount: 0,
        totalSales: 0,
        totalDiscount: 0,
      });
    }
    const row = map.get(key);
    row.transactionCount += 1;
    row.totalSales = round2(row.totalSales + sale.total_amount);
    row.totalDiscount = round2(row.totalDiscount + sale.discount_amount);
  }
  return [...map.values()].sort((a, b) => b.totalSales - a.totalSales);
}

function passthroughSales(sales) {
  return (sales || []).map((sale) => ({
    id: sale.id,
    staff_id: sale.staff_id,
    staff_name: sale.staff_name,
    customer_name: sale.customer_name,
    created_at: sale.created_at,
    status: sale.status || 'completed',
    payment_method: sale.payment_method,
    tax_percent: sale.tax_percent,
    service_charge_percent: sale.service_charge_percent,
    shift_id: sale.shift_id,
    customer_id: sale.customer_id,
    date: sale.date,
    subtotal: Number(sale.subtotal) || 0,
    discount_amount: Number(sale.discount_amount) || 0,
    total_amount: Number(sale.total_amount) || 0,
    amount_paid: Number(sale.amount_paid) || 0,
    balance_due: Number(sale.balance_due) || 0,
    payments: (sale.payments || []).map((p) => ({
      method: p.method,
      amount: Number(p.amount) || 0,
    })),
    items: mapDisplayItems(sale.items),
  }));
}

/**
 * @param {{ scopeKey: string, min: number, max: number, sales: object[] }} opts
 * @returns {{ applied: boolean, targetTotal: number|null, sales: object[], aggregates: object, staffSales: object[] }}
 */
function reduceSaleReport({ scopeKey, min, max, sales }) {
  const minN = Number(min) || 0;
  const maxN = Number(max) || 0;
  const { sales: working, realTotal } = cloneWorkingSales(sales || []);

  if (maxN <= 0 || minN < 0 || minN > maxN || realTotal <= maxN) {
    const finalSales = passthroughSales(sales);
    return {
      applied: false,
      targetTotal: null,
      sales: finalSales,
      aggregates: buildAggregates(finalSales),
      staffSales: buildStaffSales(finalSales),
    };
  }

  const targetTotal = pickTarget(scopeKey, minN, maxN);
  reduceQuantities(working, targetTotal, minN);
  const finalSales = finalizeSales(working);
  const aggregates = buildAggregates(finalSales);

  // If integer qty left us slightly above max still (edge: huge unit prices),
  // scale money proportionally as a last resort so UI always lands in range.
  if (aggregates.totalSales > maxN && aggregates.totalSales > 0) {
    const factor = targetTotal / aggregates.totalSales;
    for (const sale of finalSales) {
      const oldTotal = sale.total_amount;
      sale.subtotal = round2(sale.subtotal * factor);
      sale.discount_amount = round2(sale.discount_amount * factor);
      sale.total_amount = round2(oldTotal * factor);
      sale.payments = scalePayments(sale.payments, sale.total_amount, oldTotal);
      sale.amount_paid = round2(sale.payments.reduce((s, p) => s + p.amount, 0));
      sale.balance_due = round2(Math.max(0, sale.total_amount - sale.amount_paid));
    }
    return {
      applied: true,
      targetTotal,
      sales: finalSales,
      aggregates: buildAggregates(finalSales),
      staffSales: buildStaffSales(finalSales),
    };
  }

  return {
    applied: true,
    targetTotal,
    sales: finalSales,
    aggregates,
    staffSales: buildStaffSales(finalSales),
  };
}

module.exports = {
  reduceSaleReport,
  pickTarget,
  round2,
};
