// ── TrackMyGigs AI features (Claude Haiku 4.5) ───────────────────────────────
// One module, 10 features. Each feature is a small self-contained function that
// opens a minimal modal, posts to /api/ai/..., and either applies the result to
// an existing screen or displays it inline. No framework dependency — same
// vanilla DOM style as app.js.
//
// Exposed on window so inline onclick= handlers and app.js can call them:
//   aiSmartPasteGig()           — opens paste-to-extract modal for the Gig Wizard
//   aiScanReceipt()             — opens image/text scan modal for Expenses
//   aiDepReplyDrafter(offerId)  — drafts three replies to a dep offer
//   aiSetListGenerator()        — generates an ordered set list from repertoire
//   aiInvoiceChase(invoiceId)   — drafts three chase emails for an invoice
//   aiBioWriter()               — writes three bios (short/medium/long) for EPK
//   aiMonthlyInsight(year, month) — renders a narrative card into #aiInsightSlot
//   aiSanityCheck(fields, cb)   — runs on gig save; warns before submit
//   aiChordProNormalise()       — normalises messy chord text in ChordPro tab
//   aiEnquiryTriage()           — triages a pasted booking enquiry
//
// All calls tolerate the /api/ai endpoint returning 503 (AI disabled) by
// showing a friendly message rather than crashing the screen.

(function () {
  'use strict';

  // ── shared helpers ─────────────────────────────────────────────────────────
  function h(html) {
    const t = document.createElement('template');
    t.innerHTML = html.trim();
    return t.content.firstChild;
  }

  function esc(s) {
    if (s == null) return '';
    return String(s)
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#039;');
  }

  function toast(msg, type) {
    if (typeof window.showToast === 'function') {
      window.showToast(msg, type || 'info');
      return;
    }
    alert(msg);
  }

  async function postAI(path, body) {
    try {
      const res = await fetch('/api/ai' + path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body || {}),
      });
      if (res.status === 503) {
        toast('AI features are not configured on this server.', 'error');
        return null;
      }
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        toast(err.error || 'AI call failed', 'error');
        return null;
      }
      return await res.json();
    } catch (e) {
      console.error('[ai]', path, e);
      toast('Network error on AI call', 'error');
      return null;
    }
  }

  function openModal(title, bodyNode, opts) {
    const existing = document.getElementById('aiModalRoot');
    if (existing) existing.remove();
    const overlay = h(`
      <div id="aiModalRoot" style="position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:9999;display:flex;align-items:flex-end;justify-content:center;padding:0;">
        <div id="aiModalCard" role="dialog" aria-modal="true" style="width:100%;max-width:560px;background:var(--surface, #111);color:var(--text, #fff);border:1px solid var(--border, #222);border-radius:16px 16px 0 0;max-height:90vh;overflow:auto;display:flex;flex-direction:column;">
          <div style="display:flex;align-items:center;justify-content:space-between;padding:16px 20px;border-bottom:1px solid var(--border,#222);position:sticky;top:0;background:var(--surface,#111);z-index:1;">
            <div style="font-weight:700;font-size:16px;">${esc(title)}</div>
            <button type="button" onclick="this.closest('#aiModalRoot').remove()" style="background:none;border:none;color:var(--text-2,#999);font-size:22px;cursor:pointer;line-height:1;">&times;</button>
          </div>
          <div id="aiModalBody" style="padding:16px 20px;"></div>
        </div>
      </div>
    `);
    overlay.querySelector('#aiModalBody').appendChild(bodyNode);
    document.body.appendChild(overlay);
    // Tap outside to close unless opts.persistent
    if (!(opts && opts.persistent)) {
      overlay.addEventListener('click', (e) => {
        if (e.target === overlay) overlay.remove();
      });
    }
    return overlay;
  }

  function closeModal() {
    const m = document.getElementById('aiModalRoot');
    if (m) m.remove();
  }

  function spinner(label) {
    return h(`
      <div style="display:flex;align-items:center;gap:10px;padding:14px 0;color:var(--text-2,#999);font-size:13px;">
        <div class="ai-spinner" style="width:16px;height:16px;border:2px solid var(--border,#333);border-top-color:var(--accent,#f0a500);border-radius:50%;animation:aiSpin .9s linear infinite;"></div>
        <span>${esc(label || 'Thinking...')}</span>
      </div>
    `);
  }

  // inject the keyframes once
  (function injectStyle() {
    if (document.getElementById('aiModuleStyle')) return;
    const s = document.createElement('style');
    s.id = 'aiModuleStyle';
    s.textContent = `
      @keyframes aiSpin { to { transform: rotate(360deg); } }
      .ai-field-label { font-size:11px; text-transform:uppercase; letter-spacing:.5px; color:var(--text-3,#666); margin-bottom:4px; display:block; }
      .ai-input, .ai-textarea, .ai-select { width:100%; background:var(--bg,#0b0b0b); color:var(--text,#fff); border:1px solid var(--border,#222); border-radius:10px; padding:10px 12px; font-size:14px; font-family:inherit; box-sizing:border-box; }
      .ai-textarea { min-height:140px; resize:vertical; line-height:1.5; }
      .ai-btn { background:var(--accent,#f0a500); color:#000; border:none; border-radius:12px; padding:10px 18px; font-weight:700; font-size:14px; cursor:pointer; }
      .ai-btn-secondary { background:transparent; color:var(--text,#fff); border:1px solid var(--border,#333); border-radius:12px; padding:10px 18px; font-weight:600; font-size:14px; cursor:pointer; }
      .ai-result-card { background:var(--bg-2,#161616); border:1px solid var(--border,#222); border-radius:12px; padding:14px; margin-top:10px; }
      .ai-chip { display:inline-block; background:var(--accent-dim,rgba(240,165,0,.18)); color:var(--accent,#f0a500); border:1px solid rgba(240,165,0,.3); border-radius:12px; padding:3px 10px; font-size:11px; font-weight:600; margin-right:6px; }
      .ai-row { display:flex; gap:8px; align-items:center; margin-top:12px; }
    `;
    document.head.appendChild(s);
  })();

  // ═══════════════════════════════════════════════════════════════════════════
  // FEATURE 1 — Smart Paste to Gig Wizard
  // ═══════════════════════════════════════════════════════════════════════════
  function aiSmartPasteGig() {
    const body = h(`
      <div>
        <p style="margin:0 0 10px;font-size:13px;color:var(--text-2,#999);">Paste the booking text (email, WhatsApp, contract). I will extract the gig details and pre-fill the wizard.</p>
        <textarea id="aiPasteText" class="ai-textarea" placeholder="e.g. Hi John, confirming Saturday 3rd May at The Plough, Northwood, 8pm til 11pm, fee 280. Let me know if any issues."></textarea>
        <div class="ai-row" style="justify-content:flex-end;">
          <button type="button" class="ai-btn-secondary" onclick="document.getElementById('aiModalRoot').remove()">Cancel</button>
          <button type="button" class="ai-btn" id="aiPasteGoBtn">Extract</button>
        </div>
        <div id="aiPasteResult" style="margin-top:14px;"></div>
      </div>
    `);
    openModal('Smart Paste to Gig', body);
    body.querySelector('#aiPasteGoBtn').addEventListener('click', async () => {
      const text = body.querySelector('#aiPasteText').value.trim();
      if (!text) { toast('Paste some text first', 'warn'); return; }
      const result = body.querySelector('#aiPasteResult');
      result.innerHTML = '';
      result.appendChild(spinner('Reading booking...'));
      const data = await postAI('/extract-gig', { text });
      result.innerHTML = '';
      if (!data) return;
      result.appendChild(renderExtractedGigPreview(data));
    });
  }

  function renderExtractedGigPreview(data) {
    const conf = Number.isFinite(data.confidence) ? data.confidence : 0;
    const bits = [
      ['Band / client', data.band_name],
      ['Venue', data.venue_name],
      ['Address', data.venue_address],
      ['Date', data.date],
      ['Start', data.start_time],
      ['Finish', data.finish_time],
      ['Fee', data.fee != null ? '£' + data.fee : null],
      ['Contact', data.contact_name],
      ['Phone', data.contact_phone],
      ['Email', data.contact_email],
      ['Set length', data.set_length_minutes ? data.set_length_minutes + ' min' : null],
      ['Notes', data.notes],
    ].filter(([, v]) => v != null && v !== '');
    const rows = bits.map(([k, v]) => `
      <div style="display:flex;justify-content:space-between;gap:12px;padding:4px 0;border-bottom:1px dashed var(--border,#222);">
        <span style="color:var(--text-3,#666);font-size:12px;">${esc(k)}</span>
        <span style="font-size:13px;text-align:right;">${esc(v)}</span>
      </div>
    `).join('');
    const card = h(`
      <div class="ai-result-card">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px;">
          <div style="font-weight:700;">Extracted details</div>
          <span class="ai-chip">Confidence ${conf}%</span>
        </div>
        ${rows || '<div style="color:var(--text-3);font-size:12px;">Nothing extractable found.</div>'}
        ${data.reasoning ? `<div style="font-size:11px;color:var(--text-3,#666);margin-top:10px;line-height:1.5;">${esc(data.reasoning)}</div>` : ''}
        <div class="ai-row" style="justify-content:flex-end;">
          <button type="button" class="ai-btn-secondary" onclick="document.getElementById('aiModalRoot').remove()">Cancel</button>
          <button type="button" class="ai-btn" id="aiApplyToWizard">Use these details</button>
        </div>
      </div>
    `);
    card.querySelector('#aiApplyToWizard').addEventListener('click', () => {
      applyExtractedGigToWizard(data);
      closeModal();
    });
    return card;
  }

  // Push extracted values into the wizard global data object and re-render step 1.
  function applyExtractedGigToWizard(data) {
    if (typeof window.openGigWizard === 'function') {
      window.openGigWizard();
    }
    if (!window.gigWizardData) window.gigWizardData = {};
    const d = window.gigWizardData;
    if (data.band_name) d.band_name = data.band_name;
    if (data.venue_name) d.venue_name = data.venue_name;
    if (data.venue_address) d.venue_address = data.venue_address;
    if (data.date) d.date = data.date;
    if (data.start_time) d.start_time = data.start_time;
    if (data.finish_time) d.end_time = data.finish_time;
    if (data.fee != null) d.fee = String(data.fee);
    if (data.notes) d.notes = data.notes;
    if (typeof window.renderCreateGigScreen === 'function') {
      window.renderCreateGigScreen();
    }
    toast('Details applied to the wizard. Review each step before saving.', 'success');
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // FEATURE 2 — Receipt OCR + HMRC categoriser
  // ═══════════════════════════════════════════════════════════════════════════
  function aiScanReceipt(opts) {
    const onApply = (opts && opts.onApply) || null;
    const body = h(`
      <div>
        <p style="margin:0 0 10px;font-size:13px;color:var(--text-2,#999);">Upload a receipt photo or paste the text. I will extract merchant, amount, VAT, date, and suggest an HMRC category.</p>
        <div class="ai-row" style="flex-direction:column;align-items:stretch;gap:10px;">
          <label class="ai-btn-secondary" style="text-align:center;cursor:pointer;display:block;">
            <input type="file" id="aiReceiptFile" accept="image/*" style="display:none;">
            Choose image
          </label>
          <div style="text-align:center;font-size:11px;color:var(--text-3,#666);">or</div>
          <textarea id="aiReceiptText" class="ai-textarea" placeholder="Paste receipt text here"></textarea>
        </div>
        <div class="ai-row" style="justify-content:flex-end;">
          <button type="button" class="ai-btn-secondary" onclick="document.getElementById('aiModalRoot').remove()">Cancel</button>
          <button type="button" class="ai-btn" id="aiReceiptGo">Scan</button>
        </div>
        <div id="aiReceiptResult" style="margin-top:14px;"></div>
      </div>
    `);
    openModal('Scan Receipt', body);

    let imageData = null;
    let mediaType = null;
    const fileInput = body.querySelector('#aiReceiptFile');
    fileInput.addEventListener('change', (e) => {
      const f = e.target.files[0];
      if (!f) return;
      const reader = new FileReader();
      reader.onload = () => {
        imageData = reader.result.split(',')[1];
        mediaType = f.type || 'image/jpeg';
        const label = fileInput.closest('label');
        label.textContent = 'Ready: ' + f.name + ' (' + Math.round(f.size / 1024) + ' KB)';
        label.appendChild(fileInput);
      };
      reader.readAsDataURL(f);
    });

    body.querySelector('#aiReceiptGo').addEventListener('click', async () => {
      const text = body.querySelector('#aiReceiptText').value.trim();
      if (!imageData && !text) { toast('Upload an image or paste text', 'warn'); return; }
      const result = body.querySelector('#aiReceiptResult');
      result.innerHTML = '';
      result.appendChild(spinner('Reading receipt...'));
      const data = await postAI('/extract-receipt', { image: imageData, mediaType, text });
      result.innerHTML = '';
      if (!data) return;
      result.appendChild(renderReceiptPreview(data, onApply));
    });
  }

  function renderReceiptPreview(data, onApply) {
    const conf = Number.isFinite(data.confidence) ? data.confidence : 0;
    const rows = [
      ['Merchant', data.merchant],
      ['Amount', data.amount != null ? (data.currency || '£') + data.amount : null],
      ['VAT', data.vat != null ? (data.currency || '£') + data.vat : null],
      ['Date', data.date],
      ['Category', data.category],
      ['Notes', data.notes],
    ].filter(([, v]) => v != null && v !== '');
    const html = rows.map(([k, v]) => `
      <div style="display:flex;justify-content:space-between;gap:12px;padding:4px 0;border-bottom:1px dashed var(--border,#222);">
        <span style="color:var(--text-3,#666);font-size:12px;">${esc(k)}</span>
        <span style="font-size:13px;text-align:right;">${esc(v)}</span>
      </div>
    `).join('');
    const card = h(`
      <div class="ai-result-card">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px;">
          <div style="font-weight:700;">Extracted</div>
          <span class="ai-chip">Confidence ${conf}%</span>
        </div>
        ${html || '<div style="color:var(--text-3);font-size:12px;">Nothing readable.</div>'}
        <div class="ai-row" style="justify-content:flex-end;">
          <button type="button" class="ai-btn-secondary" onclick="document.getElementById('aiModalRoot').remove()">Close</button>
          ${onApply ? '<button type="button" class="ai-btn" id="aiReceiptApply">Add as expense</button>' : ''}
        </div>
      </div>
    `);
    if (onApply) {
      card.querySelector('#aiReceiptApply').addEventListener('click', () => {
        onApply(data);
        closeModal();
      });
    }
    return card;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // FEATURE 3 — Dep Offer Reply Drafter
  // ═══════════════════════════════════════════════════════════════════════════
  function aiDepReplyDrafter(offerText) {
    const body = h(`
      <div>
        <p style="margin:0 0 10px;font-size:13px;color:var(--text-2,#999);">Paste the dep offer message and I will draft three replies: accept, decline, and ask the fee. I will cross-check your calendar for conflicts.</p>
        <textarea id="aiDepText" class="ai-textarea" placeholder="Paste the offer message here">${esc(offerText || '')}</textarea>
        <div class="ai-row" style="justify-content:flex-end;">
          <button type="button" class="ai-btn-secondary" onclick="document.getElementById('aiModalRoot').remove()">Cancel</button>
          <button type="button" class="ai-btn" id="aiDepGo">Draft replies</button>
        </div>
        <div id="aiDepResult" style="margin-top:14px;"></div>
      </div>
    `);
    openModal('Dep Offer Replies', body);
    body.querySelector('#aiDepGo').addEventListener('click', async () => {
      const text = body.querySelector('#aiDepText').value.trim();
      if (!text) { toast('Paste the message first', 'warn'); return; }
      const result = body.querySelector('#aiDepResult');
      result.innerHTML = '';
      result.appendChild(spinner('Drafting replies...'));
      const data = await postAI('/draft-dep-reply', { text });
      result.innerHTML = '';
      if (!data) return;
      result.appendChild(renderDepReplyCards(data));
    });
  }

  function renderDepReplyCards(data) {
    const box = h('<div></div>');
    if (data.conflict) {
      box.appendChild(h(`<div style="background:rgba(255,70,70,.12);border:1px solid rgba(255,70,70,.35);border-radius:10px;padding:10px;font-size:12px;margin-bottom:10px;">&#9888;&#65039; Conflict on that date: ${esc(data.conflict)}</div>`));
    } else if (data.date_seen) {
      box.appendChild(h(`<div style="background:rgba(63,185,80,.12);border:1px solid rgba(63,185,80,.3);border-radius:10px;padding:10px;font-size:12px;margin-bottom:10px;">&#9989; No conflict on ${esc(data.date_seen)}.</div>`));
    }
    const tones = [
      ['Accept', data.accept],
      ['Decline', data.decline],
      ['Ask fee', data.ask_fee],
    ].filter(([, v]) => v);
    tones.forEach(([label, msg]) => {
      const card = h(`
        <div class="ai-result-card">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px;">
            <div style="font-weight:700;">${esc(label)}</div>
            <button type="button" class="ai-btn-secondary" style="padding:4px 10px;font-size:11px;">Copy</button>
          </div>
          <div style="font-size:13px;white-space:pre-wrap;line-height:1.55;">${esc(msg)}</div>
        </div>
      `);
      card.querySelector('button').addEventListener('click', () => {
        navigator.clipboard?.writeText(msg);
        toast('Copied', 'success');
      });
      box.appendChild(card);
    });
    return box;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // FEATURE 4 — Set List Generator
  // ═══════════════════════════════════════════════════════════════════════════
  function aiSetListGenerator() {
    const body = h(`
      <div>
        <p style="margin:0 0 10px;font-size:13px;color:var(--text-2,#999);">Generate an ordered set list from your repertoire. I will build a natural tempo arc for the crowd.</p>
        <label class="ai-field-label">Duration (min)</label>
        <input type="number" class="ai-input" id="aiSetDur" value="60" min="15" max="240">
        <div style="height:10px;"></div>
        <label class="ai-field-label">Venue</label>
        <select class="ai-select" id="aiSetVenue">
          <option value="pub">Pub / bar</option>
          <option value="wedding">Wedding</option>
          <option value="corporate">Corporate</option>
          <option value="festival">Festival</option>
          <option value="function">Function / private party</option>
          <option value="restaurant">Restaurant / background</option>
        </select>
        <div style="height:10px;"></div>
        <label class="ai-field-label">Crowd (optional)</label>
        <input type="text" class="ai-input" id="aiSetCrowd" placeholder="e.g. 30-50 year olds, lively dancers">
        <div style="height:10px;"></div>
        <label class="ai-field-label">Mood (optional)</label>
        <input type="text" class="ai-input" id="aiSetMood" placeholder="e.g. upbeat, danceable, no slow ballads">
        <div class="ai-row" style="justify-content:flex-end;">
          <button type="button" class="ai-btn-secondary" onclick="document.getElementById('aiModalRoot').remove()">Cancel</button>
          <button type="button" class="ai-btn" id="aiSetGo">Generate</button>
        </div>
        <div id="aiSetResult" style="margin-top:14px;"></div>
      </div>
    `);
    openModal('Set List Generator', body);
    body.querySelector('#aiSetGo').addEventListener('click', async () => {
      const result = body.querySelector('#aiSetResult');
      result.innerHTML = '';
      result.appendChild(spinner('Building set list...'));
      const data = await postAI('/generate-setlist', {
        duration_minutes: Number(body.querySelector('#aiSetDur').value) || 60,
        venue_type: body.querySelector('#aiSetVenue').value,
        crowd: body.querySelector('#aiSetCrowd').value,
        mood: body.querySelector('#aiSetMood').value,
      });
      result.innerHTML = '';
      if (!data) return;
      result.appendChild(renderSetListCard(data));
    });
  }

  function renderSetListCard(data) {
    if (!data.setlist || !data.setlist.length) {
      return h('<div class="ai-result-card" style="font-size:13px;color:var(--text-3);">No songs available. Add some to your repertoire first.</div>');
    }
    const items = data.setlist.map((s, i) => `
      <div style="display:flex;justify-content:space-between;gap:10px;padding:6px 0;border-bottom:1px dashed var(--border,#222);">
        <div><span style="color:var(--text-3,#666);font-size:12px;">${i + 1}.</span> <span style="font-size:13px;">${esc(s.title)}</span>${s.artist ? `<span style="color:var(--text-3,#666);font-size:11px;"> - ${esc(s.artist)}</span>` : ''}</div>
        <div style="font-size:11px;color:var(--text-3,#666);">${esc(s.tempo || '')}</div>
      </div>
    `).join('');
    const card = h(`
      <div class="ai-result-card">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px;">
          <div style="font-weight:700;">${esc(data.setlist.length)} song set</div>
          ${data.total_minutes ? `<span class="ai-chip">${esc(data.total_minutes)} min</span>` : ''}
        </div>
        ${items}
        ${data.notes ? `<div style="font-size:12px;color:var(--text-3,#666);margin-top:10px;line-height:1.5;">${esc(data.notes)}</div>` : ''}
        <div class="ai-row" style="justify-content:flex-end;">
          <button type="button" class="ai-btn-secondary" onclick="document.getElementById('aiModalRoot').remove()">Close</button>
          <button type="button" class="ai-btn" id="aiSetCopy">Copy list</button>
        </div>
      </div>
    `);
    card.querySelector('#aiSetCopy').addEventListener('click', () => {
      const plain = data.setlist.map((s, i) => `${i + 1}. ${s.title}${s.artist ? ' - ' + s.artist : ''}`).join('\n');
      navigator.clipboard?.writeText(plain);
      toast('Copied', 'success');
    });
    return card;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // FEATURE 5 — Invoice Chase Drafter
  // ═══════════════════════════════════════════════════════════════════════════
  function aiInvoiceChase(invoiceId) {
    if (!invoiceId) { toast('Invoice ID missing', 'error'); return; }
    const body = h(`
      <div>
        <p style="margin:0 0 10px;font-size:13px;color:var(--text-2,#999);">Three chase email drafts based on how overdue the invoice is.</p>
        <div id="aiChaseResult"></div>
      </div>
    `);
    openModal('Invoice Chase', body);
    const result = body.querySelector('#aiChaseResult');
    result.appendChild(spinner('Drafting chase emails...'));
    postAI('/draft-invoice-chase', { invoice_id: invoiceId }).then((data) => {
      result.innerHTML = '';
      if (!data) return;
      const tones = [
        ['Polite nudge', data.polite],
        ['Firm reminder', data.firm],
        ['Final notice', data.final],
      ].filter(([, v]) => v);
      if (data.context) {
        result.appendChild(h(`<div style="font-size:11px;color:var(--text-3,#666);margin-bottom:10px;">${esc(data.context)}</div>`));
      }
      tones.forEach(([label, msg]) => {
        const card = h(`
          <div class="ai-result-card">
            <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px;">
              <div style="font-weight:700;">${esc(label)}</div>
              <button type="button" class="ai-btn-secondary" style="padding:4px 10px;font-size:11px;">Copy</button>
            </div>
            <div style="font-size:13px;white-space:pre-wrap;line-height:1.55;">${esc(msg)}</div>
          </div>
        `);
        card.querySelector('button').addEventListener('click', () => {
          navigator.clipboard?.writeText(msg);
          toast('Copied', 'success');
        });
        result.appendChild(card);
      });
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // FEATURE 6 — Bio Writer
  // ═══════════════════════════════════════════════════════════════════════════
  function aiBioWriter(opts) {
    const onApply = opts && typeof opts.onApply === 'function' ? opts.onApply : null;
    const body = h(`
      <div>
        <p style="margin:0 0 10px;font-size:13px;color:var(--text-2,#999);">Feed me key facts. I will write three bios: short (50w), medium (150w), long (300w).</p>
        <textarea id="aiBioFacts" class="ai-textarea" placeholder="Wedding band based in London. 4 piece. Standards, soul, pop. 10 years experience. Played Kew Gardens, Claridge&#039;s, The Ned."></textarea>
        <div class="ai-row" style="justify-content:flex-end;">
          <button type="button" class="ai-btn-secondary" onclick="document.getElementById('aiModalRoot').remove()">Cancel</button>
          <button type="button" class="ai-btn" id="aiBioGo">Write</button>
        </div>
        <div id="aiBioResult" style="margin-top:14px;"></div>
      </div>
    `);
    openModal('Bio Writer', body);
    body.querySelector('#aiBioGo').addEventListener('click', async () => {
      const facts = body.querySelector('#aiBioFacts').value.trim();
      if (!facts) { toast('Enter some facts first', 'warn'); return; }
      const result = body.querySelector('#aiBioResult');
      result.innerHTML = '';
      result.appendChild(spinner('Writing bios...'));
      const data = await postAI('/generate-bio', { facts });
      result.innerHTML = '';
      if (!data) return;
      const tones = [
        ['Short (~50w)', data.short, 'short'],
        ['Medium (~150w)', data.medium, 'medium'],
        ['Long (~300w)', data.long, 'long'],
      ].filter(([, v]) => v);
      tones.forEach(([label, msg, key]) => {
        const card = h(`
          <div class="ai-result-card">
            <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px;">
              <div style="font-weight:700;">${esc(label)}</div>
              <div style="display:flex;gap:6px;">
                ${onApply ? `<button type="button" class="ai-btn" data-act="use" style="padding:4px 10px;font-size:11px;">Use this</button>` : ''}
                <button type="button" class="ai-btn-secondary" data-act="copy" style="padding:4px 10px;font-size:11px;">Copy</button>
              </div>
            </div>
            <div style="font-size:13px;white-space:pre-wrap;line-height:1.55;">${esc(msg)}</div>
          </div>
        `);
        const copyBtn = card.querySelector('[data-act="copy"]');
        if (copyBtn) copyBtn.addEventListener('click', () => {
          navigator.clipboard?.writeText(msg);
          toast('Copied', 'success');
        });
        const useBtn = card.querySelector('[data-act="use"]');
        if (useBtn && onApply) useBtn.addEventListener('click', () => {
          try {
            const payload = { short: data.short, medium: data.medium, long: data.long };
            payload.selected = msg;
            payload.selectedKey = key;
            // Convenience: put selected into .medium so callers can just use d.medium
            payload.medium = msg;
            onApply(payload);
            toast('Applied', 'success');
            closeModal();
          } catch (e) { toast('Could not apply', 'error'); }
        });
        result.appendChild(card);
      });
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // FEATURE 7 — Monthly Insight Narrative
  // ═══════════════════════════════════════════════════════════════════════════
  async function aiMonthlyInsight(year, month, targetEl) {
    const slot = targetEl || document.getElementById('aiInsightSlot');
    if (!slot) return;
    slot.innerHTML = '';
    slot.appendChild(spinner('Analysing your month...'));
    const data = await postAI('/month-summary', { year, month });
    slot.innerHTML = '';
    if (!data) return;
    const hl = (data.highlights || []).map((x) => `<li style="margin-bottom:4px;">${esc(x)}</li>`).join('');
    const sg = (data.suggestions || []).map((x) => `<li style="margin-bottom:4px;">${esc(x)}</li>`).join('');
    slot.appendChild(h(`
      <div class="ai-result-card" style="margin-top:0;">
        <div style="display:flex;align-items:center;gap:6px;margin-bottom:6px;">
          <span style="font-size:18px;">&#128221;</span>
          <div style="font-weight:700;">${esc(data.headline || 'Your month')}</div>
        </div>
        <div style="font-size:13px;line-height:1.55;margin-bottom:10px;">${esc(data.summary || '')}</div>
        ${hl ? `<div style="font-size:12px;color:var(--text-2,#ccc);font-weight:600;margin-bottom:4px;">Highlights</div><ul style="margin:0 0 10px;padding-left:18px;font-size:13px;line-height:1.5;">${hl}</ul>` : ''}
        ${sg ? `<div style="font-size:12px;color:var(--text-2,#ccc);font-weight:600;margin-bottom:4px;">Try next month</div><ul style="margin:0;padding-left:18px;font-size:13px;line-height:1.5;">${sg}</ul>` : ''}
      </div>
    `));
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // FEATURE 8 — Sanity Checks (called before saving a new gig)
  // fields: { date, start_time, venue_address, fee }
  // cb(proceed: boolean, ackedWarnings: array)
  // ═══════════════════════════════════════════════════════════════════════════
  async function aiSanityCheck(fields, cb) {
    const data = await postAI('/sanity-check', fields || {});
    if (!data || !data.warnings || !data.warnings.length) {
      cb && cb(true, []);
      return;
    }
    const lis = data.warnings.map((w) => `
      <li style="margin-bottom:6px;font-size:13px;line-height:1.5;">
        <strong style="color:var(--accent,#f0a500);">${esc(w.severity || 'note')}</strong>
        ${esc(w.message)}
      </li>
    `).join('');
    const body = h(`
      <div>
        <p style="margin:0 0 10px;font-size:13px;color:var(--text-2,#999);">Before I save, a couple of things looked off.</p>
        <ul style="margin:0 0 12px;padding-left:18px;">${lis}</ul>
        <div class="ai-row" style="justify-content:flex-end;">
          <button type="button" class="ai-btn-secondary" id="aiSanityCancel">Cancel</button>
          <button type="button" class="ai-btn" id="aiSanityGo">Save anyway</button>
        </div>
      </div>
    `);
    openModal('Heads up', body, { persistent: true });
    body.querySelector('#aiSanityCancel').addEventListener('click', () => { closeModal(); cb && cb(false, data.warnings); });
    body.querySelector('#aiSanityGo').addEventListener('click', () => { closeModal(); cb && cb(true, data.warnings); });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // FEATURE 9 — ChordPro Normaliser
  // ═══════════════════════════════════════════════════════════════════════════
  function aiChordProNormalise(opts) {
    const onApply = (opts && opts.onApply) || null;
    const seed = (opts && opts.seed) || '';
    const body = h(`
      <div>
        <p style="margin:0 0 10px;font-size:13px;color:var(--text-2,#999);">Paste messy lyrics and chords. I will clean them up into proper ChordPro and guess key + tempo.</p>
        <textarea id="aiChordIn" class="ai-textarea" placeholder="Paste chord/lyric text here">${esc(seed)}</textarea>
        <div class="ai-row" style="justify-content:flex-end;">
          <button type="button" class="ai-btn-secondary" onclick="document.getElementById('aiModalRoot').remove()">Cancel</button>
          <button type="button" class="ai-btn" id="aiChordGo">Normalise</button>
        </div>
        <div id="aiChordResult" style="margin-top:14px;"></div>
      </div>
    `);
    openModal('ChordPro Normaliser', body);
    body.querySelector('#aiChordGo').addEventListener('click', async () => {
      const text = body.querySelector('#aiChordIn').value.trim();
      if (!text) { toast('Paste chord text first', 'warn'); return; }
      const result = body.querySelector('#aiChordResult');
      result.innerHTML = '';
      result.appendChild(spinner('Cleaning up...'));
      const data = await postAI('/normalize-chordpro', { text });
      result.innerHTML = '';
      if (!data) return;
      const meta = [];
      if (data.key) meta.push(`Key: ${data.key}`);
      if (data.tempo) meta.push(`${data.tempo} BPM`);
      if (data.time_signature) meta.push(data.time_signature);
      const card = h(`
        <div class="ai-result-card">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px;">
            <div style="font-weight:700;">Cleaned</div>
            <div style="font-size:11px;color:var(--text-3,#666);">${esc(meta.join(' \u00B7 '))}</div>
          </div>
          <pre style="font-family:ui-monospace,monospace;font-size:12px;line-height:1.55;white-space:pre-wrap;margin:0;">${esc(data.cleaned || '')}</pre>
          ${data.notes ? `<div style="font-size:11px;color:var(--text-3,#666);margin-top:10px;line-height:1.5;">${esc(data.notes)}</div>` : ''}
          <div class="ai-row" style="justify-content:flex-end;">
            <button type="button" class="ai-btn-secondary" onclick="document.getElementById('aiModalRoot').remove()">Close</button>
            <button type="button" class="ai-btn" id="aiChordCopy">Copy</button>
            ${onApply ? '<button type="button" class="ai-btn" id="aiChordApply">Use this</button>' : ''}
          </div>
        </div>
      `);
      card.querySelector('#aiChordCopy').addEventListener('click', () => {
        navigator.clipboard?.writeText(data.cleaned || '');
        toast('Copied', 'success');
      });
      if (onApply) {
        card.querySelector('#aiChordApply').addEventListener('click', () => {
          onApply(data);
          closeModal();
        });
      }
      result.appendChild(card);
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // FEATURE 10 — Booking Enquiry Triage
  // ═══════════════════════════════════════════════════════════════════════════
  function aiEnquiryTriage() {
    const body = h(`
      <div>
        <p style="margin:0 0 10px;font-size:13px;color:var(--text-2,#999);">Paste a booking enquiry (form submission, DM, email). I will summarise it, suggest a fee range based on your history, and draft a reply.</p>
        <textarea id="aiEnqText" class="ai-textarea" placeholder="Paste the enquiry here"></textarea>
        <div class="ai-row" style="justify-content:flex-end;">
          <button type="button" class="ai-btn-secondary" onclick="document.getElementById('aiModalRoot').remove()">Cancel</button>
          <button type="button" class="ai-btn" id="aiEnqGo">Triage</button>
        </div>
        <div id="aiEnqResult" style="margin-top:14px;"></div>
      </div>
    `);
    openModal('Enquiry Triage', body);
    body.querySelector('#aiEnqGo').addEventListener('click', async () => {
      const text = body.querySelector('#aiEnqText').value.trim();
      if (!text) { toast('Paste an enquiry first', 'warn'); return; }
      const result = body.querySelector('#aiEnqResult');
      result.innerHTML = '';
      result.appendChild(spinner('Triaging...'));
      const data = await postAI('/triage-enquiry', { text });
      result.innerHTML = '';
      if (!data) return;
      const chips = [];
      if (data.venue_type) chips.push(`<span class="ai-chip">${esc(data.venue_type)}</span>`);
      if (data.fee_low != null && data.fee_high != null) chips.push(`<span class="ai-chip">&pound;${esc(data.fee_low)} - &pound;${esc(data.fee_high)}</span>`);
      if (data.date) chips.push(`<span class="ai-chip">${esc(data.date)}</span>`);
      const card = h(`
        <div class="ai-result-card">
          <div style="display:flex;align-items:center;gap:6px;margin-bottom:8px;flex-wrap:wrap;">
            ${chips.join('')}
          </div>
          <div style="font-size:13px;line-height:1.55;margin-bottom:10px;">${esc(data.summary || '')}</div>
          ${data.draft_reply ? `
            <div style="font-size:12px;color:var(--text-2,#ccc);font-weight:600;margin-bottom:4px;">Draft reply</div>
            <div style="font-size:13px;white-space:pre-wrap;line-height:1.55;background:var(--bg,#0b0b0b);border:1px solid var(--border,#222);border-radius:10px;padding:12px;">${esc(data.draft_reply)}</div>
          ` : ''}
          <div class="ai-row" style="justify-content:flex-end;">
            <button type="button" class="ai-btn-secondary" onclick="document.getElementById('aiModalRoot').remove()">Close</button>
            ${data.draft_reply ? '<button type="button" class="ai-btn" id="aiEnqCopy">Copy reply</button>' : ''}
          </div>
        </div>
      `);
      if (data.draft_reply) {
        card.querySelector('#aiEnqCopy').addEventListener('click', () => {
          navigator.clipboard?.writeText(data.draft_reply);
          toast('Copied', 'success');
        });
      }
      result.appendChild(card);
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // AI Tools launcher — RETIRED (#139)
  // ═══════════════════════════════════════════════════════════════════════════
  // Each of the 10 AI features now lives only in its natural home:
  //   1. Smart Paste to Gig    → Gig wizard header
  //   2. Scan Receipt          → Receipts screen "Add with AI"
  //   3. Dep Offer Replies     → Per-offer "Draft reply with AI" in Offers
  //   4. Set List Generator    → Repertoire / Set lists
  //   5. Invoice Chase         → Invoice card "AI draft chase email"
  //   6. Bio Writer            → EPK panel
  //   7. Monthly Insight       → Finance screen header
  //   8. Sanity Check          → Auto on Save Gig (no UI)
  //   9. ChordPro Normaliser   → Repertoire
  //  10. Enquiry Triage        → Top-nav quick-actions strip
  //
  // The hub modal was scaffolding from the QA push when the 10 features landed
  // together. Gareth: "I imagined these AI features being integrated in the
  // correct places rather than all in one place being able to choose."

  // Probe /status once on load; if AI is disabled, window.__aiEnabled stays
  // false and UI hooks can skip showing buttons. We still export the functions
  // so they can be called explicitly and they will show the 503 toast.
  window.__aiEnabled = false;
  fetch('/api/ai/status').then((r) => r.ok ? r.json() : null).then((j) => {
    window.__aiEnabled = !!(j && j.enabled);
    document.dispatchEvent(new CustomEvent('ai:status', { detail: j || { enabled: false } }));
  }).catch(() => {});

  // Expose every feature on window
  Object.assign(window, {
    aiSmartPasteGig,
    aiScanReceipt,
    aiDepReplyDrafter,
    aiSetListGenerator,
    aiInvoiceChase,
    aiBioWriter,
    aiMonthlyInsight,
    aiSanityCheck,
    aiChordProNormalise,
    aiEnquiryTriage,
  });
})();
