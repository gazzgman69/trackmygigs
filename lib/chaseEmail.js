// Branded HTML body for an automated overdue-invoice chase. The invoice PDF is
// attached again; this is the reminder covering note. Mirrors lib/invoiceEmail
// but with reminder copy. All brand text reads `appName` so a rename never
// touches this file.

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function gbp(n) {
  const v = Number(n);
  return Number.isFinite(v) ? '£' + (Math.round(v * 100) / 100).toFixed(2) : '';
}

function fmtDate(d) {
  if (!d) return '';
  const dt = d instanceof Date ? d : new Date(d);
  if (isNaN(dt.getTime())) return String(d).slice(0, 10);
  return dt.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

function daysOverdue(due) {
  if (!due) return 0;
  const dt = due instanceof Date ? due : new Date(due);
  if (isNaN(dt.getTime())) return 0;
  const days = Math.floor((Date.now() - dt.getTime()) / 86400000);
  return days > 0 ? days : 0;
}

// opts: { invoice, user, payUrl, appName, branded }
function renderChaseEmailHtml(opts) {
  const o = opts || {};
  const invoice = o.invoice || {};
  const user = o.user || {};
  const appName = o.appName || 'TrackMyGigs';
  const branded = o.branded !== false;
  const senderName = user.display_name || user.name || appName;
  const greetingName = (invoice.recipient_name && String(invoice.recipient_name).trim()) || 'there';
  const invNum = invoice.invoice_number || 'INV-' + String(invoice.id || '').slice(0, 6);
  const amount = gbp(invoice.amount);
  const due = fmtDate(invoice.due_date);
  const od = daysOverdue(invoice.due_date);
  const intro = `Just a friendly reminder that invoice ${esc(invNum)}${amount ? ' for ' + esc(amount) : ''} is now overdue${due ? ' (it was due on ' + esc(due) + ')' : ''}. I've attached it again for your records, and I'd be grateful if you could settle it when you get a chance. If you've already paid, please ignore this and thank you.`;

  const payButton = o.payUrl
    ? `<table role="presentation" width="100%"><tr><td style="padding:18px 0 2px;">
         <a href="${esc(o.payUrl)}" style="display:inline-block;background:#534AB7;color:#ffffff;text-decoration:none;font-weight:600;font-size:15px;padding:12px 22px;border-radius:8px;">Pay this invoice online</a>
       </td></tr></table>`
    : '';

  const footer = branded
    ? `<tr><td style="padding:18px 28px 26px;border-top:1px solid #ececec;color:#9a9a9a;font-size:12px;line-height:1.6;">Sent with ${esc(appName)}.</td></tr>`
    : '';

  return `<div style="margin:0;padding:0;background:#f5f5f7;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f5f5f7;padding:24px 0;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:12px;border:1px solid #ececec;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#1a1a1a;">
        <tr><td style="padding:26px 28px 6px;">
          <p style="margin:0 0 14px;font-size:16px;">Hi ${esc(greetingName)},</p>
          <p style="margin:0 0 18px;font-size:15px;line-height:1.6;color:#333333;">${intro}</p>
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#fafafa;border:1px solid #eeeeee;border-radius:10px;">
            <tr><td style="padding:14px 16px;">
              <div style="font-size:12px;color:#888888;text-transform:uppercase;letter-spacing:.04em;">Invoice ${od > 0 ? '· ' + od + ' day' + (od === 1 ? '' : 's') + ' overdue' : ''}</div>
              <div style="font-size:18px;font-weight:600;margin-top:2px;">${esc(invNum)}</div>
              <table role="presentation" width="100%" style="margin-top:10px;font-size:14px;color:#444444;">
                <tr><td style="padding:3px 0;">Amount due</td><td align="right" style="padding:3px 0;font-weight:600;color:#1a1a1a;">${esc(amount)}</td></tr>
                ${due ? `<tr><td style="padding:3px 0;">Was due</td><td align="right" style="padding:3px 0;">${esc(due)}</td></tr>` : ''}
              </table>
            </td></tr>
          </table>
          ${payButton}
          <p style="margin:18px 0 0;font-size:13px;color:#888888;">The invoice is attached as a PDF.</p>
          <p style="margin:18px 0 4px;font-size:15px;">Thanks,<br>${esc(senderName)}</p>
        </td></tr>
        ${footer}
      </table>
    </td></tr>
  </table>
</div>`;
}

module.exports = { renderChaseEmailHtml };
