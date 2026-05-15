// Invoice + expense flow. For each past confirmed gig, decide whether to
// create an invoice (based on persona's invoices_per_completed_gig prob).
// Of created invoices, a fraction get marked paid (will_mark_paid). A
// share start as draft and stay draft (exercises the Save Draft flow we
// fixed earlier this session).
//
// Also logs expenses for the user — the receipt-OCR AI path is mocked at
// lib/ai.js so no Anthropic spend.

async function run(client, user, ctx, createdGigs) {
  const completedGigs = (createdGigs || []).filter((g) => {
    if (g.status !== 'confirmed') return false;
    return new Date(g.date) < new Date();
  });

  const invoices = [];
  for (const gig of completedGigs) {
    const p = user.behavior.invoices_per_completed_gig || 0;
    if (ctx.rand() > p) continue;
    // ~15% are saved as drafts and left; the rest are sent.
    const startAsDraft = ctx.rand() < 0.15;
    const inv = {
      gig_id: gig.id,
      band_name: 'Test Client',
      amount: gig.fee,
      status: startAsDraft ? 'draft' : 'sent',
      payment_terms: 30,
      due_date: addDaysIso(new Date(), 30),
      description: 'Performance fee',
      recipient_email: `booker+${gig.id.slice(0, 8)}@example.com`,
      recipient_address: '123 Main Street\nLondon\nSW1A 1AA',
    };
    const res = await client.post('/api/invoices', { body: inv });
    if (!res.ok || !res.body || !res.body.id) continue;
    invoices.push({ id: res.body.id, status: inv.status });

    // Of sent invoices, mark a share paid (exercises PATCH /api/invoices/:id)
    if (!startAsDraft && ctx.rand() < (user.behavior.will_mark_paid || 0)) {
      await client.patch('/api/invoices/' + res.body.id, {
        body: { status: 'paid' },
      });
    }
    await ctx.shortPause();
  }

  // List view (exercises the cache + filter paths)
  await client.get('/api/invoices');

  // Expenses (no AI scan — that path is mocked at lib/ai.js)
  const want = user.behavior.expenses_to_log || 0;
  for (let i = 0; i < want; i++) {
    const exp = composeExpense(ctx);
    await client.post('/api/expenses', { body: exp });
    await ctx.shortPause();
  }
  if (want > 0) await client.get('/api/expenses');

  return { invoices };
}

function composeExpense(ctx) {
  const rand = ctx.rand;
  const cat = pickFrom([
    'Travel & vehicle', 'Equipment & instruments', 'Equipment repairs',
    'Accommodation', 'Subsistence', 'Mobile phone & internet',
    'Insurance', 'Subscriptions', 'Marketing & promotion',
  ], rand);
  const merchant = pickFrom([
    'Tesco', 'Sainsbury\'s', 'Shell', 'BP', 'Premier Inn', 'Travelodge',
    'Amazon', 'PMT', 'Andertons', 'Gear4music', 'Magento', 'Argos',
  ], rand);
  const amount = (5 + Math.floor(rand() * 50) * 5) + Math.floor(rand() * 100) / 100;
  // POST /api/expenses destructures { amount, description, date, category,
  // gig_id }. The merchant string lands in `description` (the table column
  // is actually `vendor` under the hood, but the route normalises that).
  return {
    description: merchant,
    amount: Math.round(amount * 100) / 100,
    date: isoDate(addDays(new Date(), -Math.floor(rand() * 90))),
    category: cat,
    gig_id: null,
  };
}

function pad2(n) { return String(n).padStart(2, '0'); }
function pickFrom(arr, rand) { return arr[Math.floor(rand() * arr.length)]; }
function addDays(d, n) { const r = new Date(d); r.setDate(r.getDate() + n); return r; }
function isoDate(d) { return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; }
function addDaysIso(d, n) { return isoDate(addDays(d, n)); }

module.exports = { run };
