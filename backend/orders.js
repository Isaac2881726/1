// src/routes/orders.js
const express = require('express');
const { pool, withTransaction } = require('../config/db');
const { verifyToken, requireCustomer } = require('../middleware/auth');
const { notifyStaffOfNewOrder } = require('../utils/sms');

const router = express.Router();

const SERVICE_FEE_PERCENT = Number(process.env.SERVICE_FEE_PERCENT || 10);

// ------------------------------------------------------------
// POST /api/orders
// Body: { buildingId, roomNumber, paymentMethod, items: [{ menuItemId, quantity }] }
//
// SECURITY NOTE: the client sends WHAT was ordered (item ids + quantities),
// never how much it costs. Every price is re-looked-up from menu_items and
// the subtotal / fee / total are computed here. A tampered "total" field
// in the request body is simply ignored.
// ------------------------------------------------------------
router.post('/', verifyToken, requireCustomer, async (req, res) => {
  const { buildingId, roomNumber, paymentMethod, items } = req.body;

  if (!buildingId || !Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'buildingId and at least one item are required' });
  }
  if (paymentMethod && !['cash', 'bank_transfer'].includes(paymentMethod)) {
    return res.status(400).json({ error: 'paymentMethod must be cash or bank_transfer' });
  }

  // Basic shape validation on each line item before we hit the DB.
  for (const item of items) {
    if (!item.menuItemId || !Number.isInteger(item.quantity) || item.quantity <= 0) {
      return res.status(400).json({ error: 'Each item needs a menuItemId and a positive integer quantity' });
    }
  }

  try {
    const order = await withTransaction(async (client) => {
      // Confirm building exists and is active.
      const buildingResult = await client.query(
        'SELECT id, name FROM buildings WHERE id = $1 AND is_active = TRUE',
        [buildingId]
      );
      if (buildingResult.rowCount === 0) {
        const err = new Error('Building not found or inactive');
        err.statusCode = 400;
        throw err;
      }
      const building = buildingResult.rows[0];

      // Look up authoritative prices for every requested item in one query.
      const menuItemIds = items.map((i) => i.menuItemId);
      const priceResult = await client.query(
        `SELECT id, name, price_cents, is_available FROM menu_items WHERE id = ANY($1::uuid[])`,
        [menuItemIds]
      );
      const priceById = new Map(priceResult.rows.map((row) => [row.id, row]));

      let subtotalCents = 0;
      const lineItems = [];

      for (const requested of items) {
        const menuItem = priceById.get(requested.menuItemId);
        if (!menuItem) {
          const err = new Error(`Menu item ${requested.menuItemId} not found`);
          err.statusCode = 400;
          throw err;
        }
        if (!menuItem.is_available) {
          const err = new Error(`"${menuItem.name}" is currently unavailable`);
          err.statusCode = 400;
          throw err;
        }

        const lineTotal = menuItem.price_cents * requested.quantity;
        subtotalCents += lineTotal;

        lineItems.push({
          menuItemId: menuItem.id,
          itemName: menuItem.name,
          unitPriceCents: menuItem.price_cents,
          quantity: requested.quantity,
          lineTotalCents: lineTotal,
        });
      }

      // Server-computed fee — the ONLY place the 10% figure is applied.
      const feeCents = Math.round((subtotalCents * SERVICE_FEE_PERCENT) / 100);
      const totalCents = subtotalCents + feeCents;

      const orderResult = await client.query(
        `INSERT INTO orders
           (customer_id, building_id, room_number, subtotal_cents, fee_cents, total_cents, payment_method, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending')
         RETURNING *`,
        [
          req.user.id,
          buildingId,
          roomNumber || null,
          subtotalCents,
          feeCents,
          totalCents,
          paymentMethod || 'cash',
        ]
      );
      const newOrder = orderResult.rows[0];

      // Bulk-insert order items.
      const insertValues = [];
      const placeholders = lineItems
        .map((item, idx) => {
          const base = idx * 5;
          insertValues.push(
            newOrder.id,
            item.menuItemId,
            item.itemName,
            item.unitPriceCents,
            item.quantity
          );
          return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 4}::int * $${base + 5}::int)`;
        })
        .join(', ');

      await client.query(
        `INSERT INTO order_items (order_id, menu_item_id, item_name, unit_price_cents, quantity, line_total_cents)
         VALUES ${placeholders}`,
        insertValues
      );

      return { ...newOrder, buildingName: building.name, items: lineItems };
    });

    // Fire the SMS notification after the transaction commits — a failed
    // SMS should never roll back a successfully placed order.
    notifyStaffOfNewOrder({
      id: order.id,
      buildingName: order.buildingName,
      totalCents: order.total_cents,
    }).catch((err) => console.error('SMS notify failed', err));

    res.status(201).json({ order });
  } catch (err) {
    console.error('create order error', err);
    res.status(err.statusCode || 500).json({ error: err.statusCode ? err.message : 'Failed to create order' });
  }
});

// ------------------------------------------------------------
// GET /api/orders/:id — customer checks their own order status
// ------------------------------------------------------------
router.get('/:id', verifyToken, requireCustomer, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT o.*, b.name AS building_name
       FROM orders o
       JOIN buildings b ON b.id = o.building_id
       WHERE o.id = $1 AND o.customer_id = $2`,
      [req.params.id, req.user.id]
    );
    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Order not found' });
    }

    const itemsResult = await pool.query(
      `SELECT item_name, unit_price_cents, quantity, line_total_cents FROM order_items WHERE order_id = $1`,
      [req.params.id]
    );

    res.json({ order: { ...result.rows[0], items: itemsResult.rows } });
  } catch (err) {
    console.error('get order error', err);
    res.status(500).json({ error: 'Failed to fetch order' });
  }
});

// ------------------------------------------------------------
// GET /api/orders — customer's own order history
// ------------------------------------------------------------
router.get('/', verifyToken, requireCustomer, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, status, total_cents, created_at FROM orders
       WHERE customer_id = $1 ORDER BY created_at DESC LIMIT 50`,
      [req.user.id]
    );
    res.json({ orders: result.rows });
  } catch (err) {
    console.error('list orders error', err);
    res.status(500).json({ error: 'Failed to fetch orders' });
  }
});

module.exports = router;
