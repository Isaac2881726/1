// src/utils/sms.js
// Placeholder SMS sender. Swap the body of `sendSms` for a real provider
// (Twilio, Clickatell, BulkSMS, etc.) when you're ready — the call sites
// elsewhere in the app don't need to change.

const STAFF_PHONE_NUMBERS = (process.env.STAFF_PHONE_NUMBERS || '')
  .split(',')
  .map((n) => n.trim())
  .filter(Boolean);

/**
 * Send a single SMS. Currently just logs — replace with a real API call.
 * @param {string} to E.164 phone number
 * @param {string} message
 */
async function sendSms(to, message) {
  // TODO: replace with real provider, e.g.:
  // await twilioClient.messages.create({ to, from: TWILIO_FROM, body: message });
  console.log(`[SMS MOCK] -> ${to}: ${message}`);
  return { to, message, sentAt: new Date().toISOString(), mock: true };
}

/**
 * Notify every configured staff number that a new order has come in.
 * Fire-and-forget from the caller's perspective — failures are logged,
 * not thrown, so a flaky SMS provider never breaks order creation.
 * @param {{id: string, buildingName: string, totalCents: number}} order
 */
async function notifyStaffOfNewOrder(order) {
  const zar = (order.totalCents / 100).toFixed(2);
  const message = `New order #${order.id.slice(0, 8)} — ${order.buildingName} — R${zar}. Accept it in the dashboard.`;

  const results = await Promise.allSettled(
    STAFF_PHONE_NUMBERS.map((number) => sendSms(number, message))
  );

  results.forEach((result, i) => {
    if (result.status === 'rejected') {
      console.error(`Failed to SMS ${STAFF_PHONE_NUMBERS[i]}:`, result.reason);
    }
  });
}

module.exports = { sendSms, notifyStaffOfNewOrder, STAFF_PHONE_NUMBERS };
