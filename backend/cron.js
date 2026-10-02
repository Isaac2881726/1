// src/utils/cron.js
// Background job: any order still 'pending' (i.e. no staff accepted it)
// after ORDER_TIMEOUT_MINUTES gets auto-cancelled. Runs every minute.

const cron = require('node-cron');
const { pool } = require('../config/db');

const TIMEOUT_MINUTES = Number(process.env.ORDER_TIMEOUT_MINUTES || 5);

/**
 * One-shot function that performs the cancellation sweep.
 * Exported separately from the schedule so it can be unit-tested or
 * triggered manually (e.g. from an admin "run now" button) without
 * waiting for the cron tick.
 */
async function cancelStaleOrders() {
  try {
    const result = await pool.query(
      `UPDATE orders
       SET status = 'cancelled', cancelled_at = now(), cancel_reason = 'timeout'
       WHERE status = 'pending'
         AND created_at < now() - ($1 || ' minutes')::interval
       RETURNING id, customer_id, created_at`,
      [TIMEOUT_MINUTES]
    );

    if (result.rowCount > 0) {
      console.log(`[cron] Auto-cancelled ${result.rowCount} stale order(s):`, result.rows.map((r) => r.id));
      // TODO: optionally SMS/email the affected customers here.
    }
    return result.rows;
  } catch (err) {
    console.error('[cron] Failed to sweep stale orders', err);
    return [];
  }
}

/**
 * Registers the recurring job. Call once at server startup.
 */
function startOrderTimeoutCron() {
  // Every minute — cheap query (indexed on status + created_at) and keeps
  // the customer-facing "cancelled" status accurate within ~60s.
  cron.schedule('* * * * *', () => {
    cancelStaleOrders();
  });
  console.log(`[cron] Order timeout sweep scheduled (timeout = ${TIMEOUT_MINUTES}m)`);
}

module.exports = { startOrderTimeoutCron, cancelStaleOrders };
