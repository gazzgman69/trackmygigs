// Onboarding flow: runs once per virtual user immediately after the admin
// endpoint creates them. Patches the profile with rate-card, bio, photo URL,
// and (sometimes) a public slug + EPK content. Exercises:
//   - PATCH /api/user/profile (boolean + array + JSON column edits)
//   - POST  /api/user/slug    (public_slug minting + uniqueness)
//   - GET   /api/user/profile (the new gigs_count / acts_count / total_earned
//                              aggregation we shipped earlier this session)
//   - GET   /api/ai/status    (feature-detect, also tells us if Whisper is on)

async function run(client, user, ctx) {
  // Patch the profile with the rest of the persona's signature fields.
  const bio = bioFor(user, ctx.rand);
  const patch = {
    bio,
    travel_radius_miles: user.travel_radius_miles,
    discoverable: user.discoverable,
    allow_direct_messages: user.allow_direct_messages,
    available_now: user.available_now,
    min_fee_pence: 3000 + Math.floor(ctx.rand() * 10) * 500,
    notify_free_gigs: ctx.rand() < 0.3,
    rate_standard: 150 + Math.floor(ctx.rand() * 20) * 25,
    rate_premium: 250 + Math.floor(ctx.rand() * 20) * 25,
    rate_dep: 100 + Math.floor(ctx.rand() * 15) * 25,
    rate_notes: bio.slice(0, 80),
  };
  if (user.available_now && user.available_now_until) {
    patch.available_now_duration_days = 7;
  }
  await client.patch('/api/user/profile', { body: patch });

  // Half of all users mint a public_slug (used for /share/:slug pages)
  if (ctx.rand() < 0.5) {
    await client.post('/api/user/slug', { body: {} });
  }

  // Hit the profile read to verify the aggregation columns (gigs_count etc)
  // come back even when zero. Tests the "Profile 0/0/£0" bug regression.
  await client.get('/api/user/profile');

  // Status probe — every authed session does this once anyway as part of
  // the AI feature-detect on first load.
  await client.get('/api/ai/status');
}

function bioFor(user, rand) {
  const insLabel = user.instruments.slice(0, 2).join(' + ');
  const genreLabel = user.genres.slice(0, 2).join(' / ');
  const variants = [
    `${insLabel} player based in ${user.region}. ${genreLabel} mainly, happy to dep across the patch.`,
    `${user.region} gigging ${insLabel.toLowerCase()}. Function bands, ${genreLabel.toLowerCase()}, anything fun.`,
    `${insLabel}, ${user.region}. Open to deps within ${user.travel_radius_miles || 50}mi.`,
    `${genreLabel} ${insLabel.toLowerCase()}. Sessions, weddings, the lot.`,
  ];
  return variants[Math.floor(rand() * variants.length)];
}

module.exports = { run };
