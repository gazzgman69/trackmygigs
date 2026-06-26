// Shared transactional email sender. Prefers Resend's HTTPS API when
// RESEND_API_KEY is set, otherwise falls back to Gmail SMTP (beta only).
// Lifted out of routes/auth.js so invoice sending can reuse it with
// attachments, a per-send From display name, and a Reply-To. Magic-link
// login still calls the same sendEmail({ to, subject, html }) shape.

const nodemailer = require('nodemailer');

// The product name is still a placeholder, so every brand mention reads this
// one value. A rename is one env change (APP_NAME), not a code sweep.
const APP_NAME = process.env.APP_NAME || 'TrackMyGigs';

// Gmail fallback for when RESEND_API_KEY is absent (dev / beta).
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.GMAIL_USER,
    pass: process.env.GMAIL_APP_PASSWORD,
  },
});

function defaultFrom() {
  return process.env.MAIL_FROM || `${APP_NAME} <no-reply@trackmygigs.app>`;
}

// Pull the bare address out of a "Name <addr@host>" string.
function addressOf(fromStr) {
  const m = /<([^>]+)>/.exec(String(fromStr || ''));
  return (m ? m[1] : String(fromStr || '')).trim();
}

function domainOf(addr) {
  const i = String(addr || '').lastIndexOf('@');
  return i >= 0 ? addr.slice(i + 1) : '';
}

// The address invoices are sent FROM. Domain follows MAIL_FROM so it tracks
// the eventual real domain; local part defaults to "invoices". Override the
// whole thing with INVOICE_FROM if needed.
function invoiceFromAddress() {
  if (process.env.INVOICE_FROM) return process.env.INVOICE_FROM;
  const local = process.env.INVOICE_FROM_LOCAL || 'invoices';
  const domain = domainOf(addressOf(defaultFrom())) || 'trackmygigs.app';
  return `${local}@${domain}`;
}

// Strip characters that would break the "Name <addr>" header.
function cleanName(s) {
  return String(s || '').replace(/["\r\n<>]/g, '').trim().slice(0, 120);
}

// sendEmail({ to, subject, html, text?, fromName?, fromAddress?, replyTo?, attachments? })
//   fromName     -> shown as the sender display name (e.g. the musician), the
//                   address stays the configured sending address.
//   attachments  -> [{ filename, content: Buffer }]
async function sendEmail({ to, subject, html, text, fromName, fromAddress, replyTo, attachments }) {
  let from = defaultFrom();
  if (fromName) {
    const addr = fromAddress || addressOf(defaultFrom()) || 'no-reply@trackmygigs.app';
    from = `${cleanName(fromName)} <${addr}>`;
  } else if (fromAddress) {
    from = `${APP_NAME} <${fromAddress}>`;
  }

  if (process.env.RESEND_API_KEY) {
    const body = { from, to, subject, html };
    if (text) body.text = text;
    if (replyTo) body.reply_to = replyTo;
    if (attachments && attachments.length) {
      body.attachments = attachments.map((a) => ({
        filename: a.filename,
        content: Buffer.isBuffer(a.content) ? a.content.toString('base64') : a.content,
      }));
    }
    const resp = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    if (!resp.ok) {
      const errBody = await resp.text().catch(() => '');
      throw new Error(`Resend send failed (${resp.status}): ${errBody}`);
    }
    return;
  }

  // Fallback: Gmail SMTP (beta). nodemailer takes Buffers directly.
  const msg = {
    from: fromName
      ? `"${cleanName(fromName)}" <${process.env.GMAIL_USER}>`
      : `"${APP_NAME}" <${process.env.GMAIL_USER}>`,
    to,
    subject,
    html,
  };
  if (text) msg.text = text;
  if (replyTo) msg.replyTo = replyTo;
  if (attachments && attachments.length) {
    msg.attachments = attachments.map((a) => ({ filename: a.filename, content: a.content }));
  }
  await transporter.sendMail(msg);
}

module.exports = { sendEmail, APP_NAME, invoiceFromAddress };
