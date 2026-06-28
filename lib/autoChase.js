// Opt-in automated invoice chasing. For users who switched it on, find overdue
// SENT invoices past their cooldown (and under a hard chase cap), and email a
// reminder with the invoice attached, reusing the same server-side send pipeline
// as the manual send. OFF by default (the app's principle is nothing-auto-sends),
// so only opted-in users are ever swept. dryRun selects but sends nothing.

const db = require('../db');
const { sendEmail, APP_NAME, invoiceFromAddress } = require('./email');
const { renderInvoicePdfBuffer, buildInvoiceFilename } = require('./invoicePdf');
const { renderChaseEmailHtml } = require('./chaseEmail');

const CHASE_CAP = 3; // never chase the same invoice more than this many times

async function runAutoChaseSweep(opts = {}) {
  const dryRun = !!opts.dryRun;
  const out = { dryRun, scanned: 0, sent: 0, errors: 0, cap: CHASE_CAP, details: [] };
  let rows;
  try {
    // The row carries invoice columns (i.*) AND the chasing user's fields, with
    // no overlapping names, so it doubles as both the invoice and user args to
    // the PDF renderer / chase template.
    rows = (await db.query(
      `SELECT i.*, u.display_name, u.name, u.email, u.business_address, u.business_phone,
              u.vat_number, u.bank_details, u.payment_link_url,
              COALESCE(u.auto_chase_cooldown_days, 7) AS cooldown_days
         FROM invoices i
         JOIN users u ON u.id = i.user_id
        WHERE u.auto_chase_enabled = TRUE
          AND i.status = 'sent'
          AND i.due_date IS NOT NULL AND i.due_date < CURRENT_DATE
          AND i.recipient_email IS NOT NULL AND TRIM(i.recipient_email) <> ''
          AND COALESCE(i.chase_count, 0) < $1
          AND (i.last_chase_at IS NULL
               OR i.last_chase_at < NOW() - (COALESCE(u.auto_chase_cooldown_days, 7) * INTERVAL '1 day'))`,
      [CHASE_CAP]
    )).rows;
  } catch (e) {
    out.errors++;
    out.error = String(e.message || e).slice(0, 200);
    return out;
  }
  out.scanned = rows.length;

  for (const inv of rows) {
    const num = inv.invoice_number || 'INV-' + String(inv.id).slice(0, 6);
    if (dryRun) {
      out.details.push({ invoice: num, to: inv.recipient_email, chase_count: inv.chase_count || 0, would_send: true });
      continue;
    }
    try {
      const pdf = await renderInvoicePdfBuffer(inv, inv, {});
      const filename = buildInvoiceFilename(inv);
      const html = renderChaseEmailHtml({ invoice: inv, user: inv, appName: APP_NAME });
      await sendEmail({
        to: inv.recipient_email,
        subject: `Reminder: invoice ${num} is overdue`,
        html,
        fromName: inv.display_name || inv.name || APP_NAME,
        fromAddress: invoiceFromAddress(),
        replyTo: inv.email || undefined,
        attachments: [{ filename, content: pdf }],
      });
      await db.query(
        `UPDATE invoices SET chase_count = COALESCE(chase_count, 0) + 1, last_chase_at = NOW(), chased_at = NOW() WHERE id = $1`,
        [inv.id]
      );
      out.sent++;
      out.details.push({ invoice: num, to: inv.recipient_email, sent: true });
    } catch (e) {
      out.errors++;
      out.details.push({ invoice: num, error: String(e.message || e).slice(0, 120) });
    }
  }
  return out;
}

module.exports = { runAutoChaseSweep, CHASE_CAP };
