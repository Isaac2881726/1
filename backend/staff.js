// src/routes/staff.js
const express = require('express');
const { pool } = require('../config/db');
const { verifyToken, requireStaff } = require('../middleware/auth');

const router = express.Router();

// ------------------------------------------------------------
// GET /api/staff/orders — dashboard feed of orders staff can act on
// ------------------------------------------------------------
router.get('/orders', verifyToken, requireStaff(), async (req, res) => {
  try {
    const statusFilter = req.query.status; // optional: pending | accepted | delivered | cancelled
    const params = [];
    let where = '';
    if (statusFilter) {
      params.push(statusFilter);
      where = 'WHERE o.status = $1';
    } else {
      // Default view: anything still "live" — not yet delivered or cancelled.
      where = "WHERE o.status IN ('pending', 'accepted')";
    }

    const result = await pool.query(
      `SELECT o.id, o.status, o.total_cents, o.payment_method, o.room_number,
              o.created_at, o.accepted_at, b.name AS building_name,
              c.full_name AS customer_name, c.phone AS customer_phone
       FROM orders o
       JOIN buildings b ON b.id = o.building_id
       JOIN customers c ON c.id = o.customer_id
       ${where}
       ORDER BY o.created_at ASC`,
      params
    );
    res.json({ orders: result.rows });
  } catch (err) {
    console.error('staff list orders error', err);
    res.status(500).json({ error: 'Failed to fetch orders' });
  }
});

// ------------------------------------------------------------
// POST /api/staff/orders/:id/accept
//
// CONCURRENCY: if two runners tap "Accept" at the same instant, only one
// may win. We do this WITHOUT a manual lock/mutex by relying on Postgres's
// own row-level locking: a single UPDATE ... WHERE status = 'pending' is
// atomic. Whichever request's UPDATE commits first flips the row to
// 'accepted', so the second request's WHERE clause no longer matches any
// row (status is no longer 'pending') and it updates zero rows. We check
// rowCount to tell the two cases apart. This is the standard "optimistic
// compare-and-swap" pattern and needs no explicit SELECT ... FOR UPDATE.
// ------------------------------------------------------------
router.post('/orders/:id/accept', verifyToken, requireStaff(), async (req, res) => {
  const { id } = req.params;
  const staffId = req.user.id;

  try {
    const result = await pool.query(
      `UPDATE orders
       SET status = 'accepted', accepted_by_staff_id = $1, accepted_at = now()
       WHERE id = $2 AND status = 'pending'
       RETURNING id, status, accepted_by_staff_id, accepted_at`,
      [staffId, id]
    );

    if (result.rowCount === 1) {
      // We won the race.
      return res.json({ order: result.rows[0], message: 'Order accepted' });
    }

    // rowCount === 0 means either the order doesn't exist, or it already
    // moved out of 'pending' (another runner beat us to it, or it was
    // cancelled/timed out). Distinguish those for a clearer error message.
    const existing = await pool.query('SELECT id, status, accepted_by_staff_id FROM orders WHERE id = $1', [id]);
    if (existing.rowCount === 0) {
      return res.status(404).json({ error: 'Order not found' });
    }

    const current = existing.rows[0];
    if (current.status === 'accepted') {
      return res.status(409).json({
        error: 'Order already accepted by another staff member',
        acceptedByStaffId: current.accepted_by_staff_id,
      });
    }
    return res.status(409).json({ error: `Order is no longer available (status: ${current.status})` });
  } catch (err) {
    console.error('accept order error', err);
    res.status(500).json({ error: 'Failed to accept order' });
  }
});

// ------------------------------------------------------------
// POST /api/staff/orders/:id/deliver — mark an accepted order delivered.
// Only the staff member who accepted it (or an admin) may complete it.
// ------------------------------------------------------------
router.post('/orders/:id/deliver', verifyToken, requireStaff(), async (req, res) => {
  const { id } = req.params;

  try {
    const result = await pool.query(
      `UPDATE orders
       SET status = 'delivered', delivered_at = now()
       WHERE id = $1
         AND status = 'accepted'
         AND (accepted_by_staff_id = $2 OR $3 = 'admin')
       RETURNING id, status, delivered_at`,
      [id, req.user.id, req.user.role]
    );

    if (result.rowCount === 0) {
      return res.status(409).json({ error: 'Order cannot be marked delivered (wrong state or not yours)' });
    }
    res.json({ order: result.rows[0] });
  } catch (err) {
    console.error('deliver order error', err);
    res.status(500).json({ error: 'Failed to update order' });
  }
});

module.exports = router;
