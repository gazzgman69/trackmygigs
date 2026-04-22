// ── TrackMyGigs invoice PDF renderer ────────────────────────────────────────
// Produces a clean A4 PDF mirroring /api/print/invoice/:id. Shared by the
// download button, the chase email Web Share attachment, and the initial
// Send flow. Uses pdfkit (pure JS, no headless browser, Replit-friendly).
//
// Exports:
//   renderInvoicePdfBuffer(invoice, user) -> Promise<Buffer>
//     `invoice` row from DB; `user` row with display_name/business_address/
//     vat_number/bank_details. Resolves with a complete PDF Buffer.
//   buildInvoiceFilename(invoice) -> string
//     Returns e.g. "Invoice_INV-1001_TrackMyGigs.pdf" for Content-Disposition
//     and the File name supplied to Web Share.

const PDFDocument = require('pdfkit');

function gbp(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return '';
  return '\u00a3' + (Math.round(v * 100) / 100).toFixed(2);
}

function fmtDate(d) {
  if (!d) return '';
  const dt = d instanceof Date ? d : new Date(d);
  if (isNaN(dt.getTime())) return String(d).slice(0, 10);
  return dt.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

function sanitizeFilenameFragment(s) {
  return String(s || '').replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60);
}

function buildInvoiceFilename(invoice) {
  const num = sanitizeFilenameFragment(invoice.invoice_number || `INV-${String(invoice.id || '').slice(0, 6)}`);
  return `Invoice_${num || 'TrackMyGigs'}.pdf`;
}

function renderInvoicePdfBuffer(invoice, user) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({
        size: 'A4',
        // Small bottom margin so the footer rule + text sits inside the
        // usable area and pdfkit doesn't auto-paginate onto a blank page 2.
        margins: { top: 50, left: 50, right: 50, bottom: 30 },
        info: {
          Title: `Invoice ${invoice.invoice_number || ''}`.trim(),
          Author: user.display_name || user.name || 'TrackMyGigs',
          Creator: 'TrackMyGigs',
        },
      });

      const chunks = [];
      doc.on('data', (c) => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      const PAGE_W = doc.page.width;
      const PAGE_H = doc.page.height;
      const LEFT = doc.page.margins.left;
      const RIGHT = PAGE_W - doc.page.margins.right;
      const CONTENT_W = RIGHT - LEFT;

      const INK = '#111111';
      const MUTED = '#555555';
      const HINT = '#777777';
      const RULE = '#E5E7EB';
      const BG = '#F6F7F9';

      // ── Header: business name + meta on left, INVOICE label on right ──────
      const fromName = user.display_name || user.name || 'TrackMyGigs user';
      const fromMeta = [];
      if (user.business_address) fromMeta.push(...String(user.business_address).split('\n'));
      if (user.vat_number) fromMeta.push(`VAT: ${user.vat_number}`);

      doc.fillColor(INK).font('Helvetica-Bold').fontSize(18).text(fromName, LEFT, 50, {
        width: CONTENT_W * 0.55,
      });
      if (fromMeta.length) {
        doc.fillColor(MUTED).font('Helvetica').fontSize(9).text(fromMeta.join('\n'), LEFT, doc.y + 2, {
          width: CONTENT_W * 0.55,
          lineGap: 1,
        });
      }

      const invDate = fmtDate(invoice.created_at || new Date());
      const invNumber = invoice.invoice_number || 'INV-001';
      doc.fillColor(INK).font('Helvetica-Bold').fontSize(24).text('INVOICE', LEFT, 50, {
        width: CONTENT_W,
        align: 'right',
      });
      doc.fillColor(MUTED).font('Helvetica').fontSize(10);
      doc.text(invNumber, LEFT, 78, { width: CONTENT_W, align: 'right' });
      doc.text(invDate, LEFT, 92, { width: CONTENT_W, align: 'right' });

      // ── Bill-to + due block ───────────────────────────────────────────────
      const billToY = Math.max(doc.y, 120) + 18;
      const blockH = 60;
      doc.save().fillColor(BG).rect(LEFT, billToY, CONTENT_W, blockH).fill().restore();

      const colW = CONTENT_W / 2;
      doc.fillColor(HINT).font('Helvetica-Bold').fontSize(8).text(
        'BILL TO', LEFT + 12, billToY + 10, { width: colW - 20, characterSpacing: 1 },
      );
      doc.fillColor(INK).font('Helvetica-Bold').fontSize(12).text(
        invoice.band_name || invoice.g_band || '',
        LEFT + 12, billToY + 24,
        { width: colW - 20 },
      );

      doc.fillColor(HINT).font('Helvetica-Bold').fontSize(8).text(
        'PAYMENT DUE', LEFT + colW + 12, billToY + 10, { width: colW - 20, characterSpacing: 1 },
      );
      const dueText = invoice.due_date
        ? fmtDate(invoice.due_date)
        : (invoice.payment_terms || 'On receipt');
      doc.fillColor(INK).font('Helvetica-Bold').fontSize(12).text(
        dueText, LEFT + colW + 12, billToY + 24, { width: colW - 20 },
      );

      // ── Line item table ───────────────────────────────────────────────────
      const tableY = billToY + blockH + 22;
      const amtColW = 120;
      const descColW = CONTENT_W - amtColW;

      // header row
      doc.fillColor(HINT).font('Helvetica-Bold').fontSize(8);
      doc.text('DESCRIPTION', LEFT + 4, tableY, { width: descColW - 8, characterSpacing: 1 });
      doc.text('AMOUNT', LEFT + descColW + 4, tableY, {
        width: amtColW - 8, align: 'right', characterSpacing: 1,
      });
      // thick rule under header
      doc.save().lineWidth(1.5).strokeColor(INK)
        .moveTo(LEFT, tableY + 14).lineTo(RIGHT, tableY + 14).stroke().restore();

      const desc = invoice.description
        || (invoice.g_venue
          ? `Performance fee \u00b7 ${invoice.g_venue}${invoice.g_date ? ' \u00b7 ' + fmtDate(invoice.g_date) : ''}`
          : 'Performance fee');
      const amount = gbp(invoice.amount || 0);

      const rowY = tableY + 24;
      doc.fillColor(INK).font('Helvetica').fontSize(11)
        .text(desc, LEFT + 4, rowY, { width: descColW - 8 });
      const rowTextH = Math.max(doc.y - rowY, 14);
      doc.fillColor(INK).font('Helvetica-Bold').fontSize(11)
        .text(amount, LEFT + descColW + 4, rowY, {
          width: amtColW - 8, align: 'right',
        });

      let cursor = rowY + rowTextH + 8;

      // venue sub-line if we have one and it's not already in description
      const venueLine = invoice.venue_name || invoice.g_venue || '';
      if (venueLine && !desc.includes(venueLine)) {
        const sub = `${venueLine}${invoice.g_date ? ' \u00b7 ' + fmtDate(invoice.g_date) : ''}`;
        doc.fillColor(HINT).font('Helvetica').fontSize(9)
          .text(sub, LEFT + 4, cursor, { width: descColW - 8 });
        cursor = doc.y + 6;
      }

      // row separator
      doc.save().lineWidth(0.5).strokeColor(RULE)
        .moveTo(LEFT, cursor).lineTo(RIGHT, cursor).stroke().restore();
      cursor += 14;

      // total
      doc.fillColor(MUTED).font('Helvetica').fontSize(11)
        .text('Total due', LEFT + 4, cursor, {
          width: CONTENT_W - amtColW - 8, align: 'right',
        });
      doc.fillColor(INK).font('Helvetica-Bold').fontSize(18)
        .text(amount, LEFT + descColW + 4, cursor - 4, {
          width: amtColW - 8, align: 'right',
        });
      cursor += 28;

      // ── Payment details panel ─────────────────────────────────────────────
      if (user.bank_details) {
        const bankLines = String(user.bank_details).split('\n');
        const bankH = 28 + bankLines.length * 13;
        doc.save().fillColor(BG).rect(LEFT, cursor, CONTENT_W, bankH).fill().restore();
        doc.fillColor(HINT).font('Helvetica-Bold').fontSize(8)
          .text('PAYMENT DETAILS', LEFT + 12, cursor + 10, {
            width: CONTENT_W - 24, characterSpacing: 1,
          });
        doc.fillColor(INK).font('Helvetica').fontSize(10)
          .text(bankLines.join('\n'), LEFT + 12, cursor + 24, {
            width: CONTENT_W - 24, lineGap: 2,
          });
        cursor += bankH + 12;
      }

      // ── Notes ─────────────────────────────────────────────────────────────
      if (invoice.notes) {
        doc.fillColor(MUTED).font('Helvetica').fontSize(9)
          .text(String(invoice.notes), LEFT, cursor, {
            width: CONTENT_W, lineGap: 2,
          });
        cursor = doc.y + 8;
      }

      // ── Footer ────────────────────────────────────────────────────────────
      // Sit above the bottom margin so the single-line text doesn't overflow
      // the page and trigger pdfkit's auto-pagination.
      const footerY = PAGE_H - 40;
      doc.save().lineWidth(0.5).strokeColor(RULE)
        .moveTo(LEFT, footerY - 8).lineTo(RIGHT, footerY - 8).stroke().restore();
      doc.fillColor(HINT).font('Helvetica').fontSize(8)
        .text('Generated with TrackMyGigs \u00b7 trackmygigs.app',
          LEFT, footerY, {
            width: CONTENT_W, align: 'center', lineBreak: false,
          });

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

module.exports = { renderInvoicePdfBuffer, buildInvoiceFilename };
