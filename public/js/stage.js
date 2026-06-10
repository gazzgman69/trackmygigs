// Stage mode: the phone-as-music-stand performance view, plus the chord
// transpose maths it depends on. Loaded after app.js; uses its globals
// (escapeHtml, escapeAttr, showToast, window._setlistDetailCache).

(function () {
  'use strict';

  // ── Chord transpose ────────────────────────────────────────────────────────

  const SHARPS = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  const FLATS = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];

  function noteIndex(note) {
    let i = SHARPS.indexOf(note);
    if (i === -1) i = FLATS.indexOf(note);
    return i;
  }

  // Shift one chord token (e.g. "Bbm7/F") by semitones. Output spelling
  // follows the original: flat chords stay flat, sharp chords stay sharp.
  function transposeChord(chord, semis) {
    if (!semis) return chord;
    const preferFlats = chord.includes('b') && !chord.includes('#');
    const scale = preferFlats ? FLATS : SHARPS;
    return chord.replace(/([A-G][b#]?)/g, (note) => {
      const i = noteIndex(note);
      if (i === -1) return note;
      return scale[((i + semis) % 12 + 12) % 12];
    });
  }
  window.transposeChord = transposeChord;

  // ── ChordPro rendering ─────────────────────────────────────────────────────

  // Lyrics with [Chord] tokens become HTML with superscript chord marks.
  // Directives like {title:..} are dropped (the screen already shows them);
  // section directives become spacing.
  function renderChordProHtml(lyrics, semis) {
    if (!lyrics) return '';
    const lines = String(lyrics).split('\n');
    const out = [];
    for (const raw of lines) {
      const line = raw.trimEnd();
      const dm = line.match(/^\{\s*([a-z_]+)\s*:?\s*(.*?)\s*\}$/i);
      if (dm) {
        const d = dm[1].toLowerCase();
        if (d.startsWith('start_of_')) out.push('<div class="stg-sec">' + escapeHtml(d.replace('start_of_', '').toUpperCase()) + '</div>');
        continue;
      }
      const html = escapeHtml(line).replace(/\[([^\]]+)\]/g, (m, c) =>
        '<b>' + escapeHtml(transposeChord(c, semis)) + '</b>');
      out.push(html || '&nbsp;');
    }
    return out.join('<br>');
  }

  // ── State ──────────────────────────────────────────────────────────────────

  const S = {
    sl: null,          // setlist row (with songs expanded)
    ordered: [],       // songs in set order
    meta: {},          // stage_meta (breaks, markers, notes, speeds, transpose)
    index: 0,
    startedAt: 0,
    clockTimer: null,
    scroll: { on: false, raf: 0, last: 0, speed: 40 },
    wakeLock: null,
    fontScale: parseFloat(localStorage.getItem('tmg_stage_font')) || 1,
    saveTimer: null,
  };

  function setsOf() {
    // breaks are indices where a new set STARTS. Returns array of [start, end).
    const breaks = (S.meta.breaks || []).filter(b => b > 0 && b < S.ordered.length).sort((a, b) => a - b);
    const bounds = [0, ...breaks, S.ordered.length];
    const sets = [];
    for (let i = 0; i < bounds.length - 1; i++) sets.push([bounds[i], bounds[i + 1]]);
    return sets;
  }

  function setOfIndex(idx) {
    const sets = setsOf();
    for (let i = 0; i < sets.length; i++) {
      if (idx >= sets[i][0] && idx < sets[i][1]) return { num: i + 1, start: sets[i][0], end: sets[i][1], count: sets.length };
    }
    return { num: 1, start: 0, end: S.ordered.length, count: 1 };
  }

  function saveMetaDebounced() {
    clearTimeout(S.saveTimer);
    S.saveTimer = setTimeout(async () => {
      try {
        await fetch('/api/setlists/' + encodeURIComponent(S.sl.id), {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ stage_meta: S.meta }),
        });
        if (window._setlistDetailCache && window._setlistDetailCache.id === S.sl.id) {
          window._setlistDetailCache.stage_meta = S.meta;
        }
      } catch (err) { /* stage must never block on the network */ }
    }, 900);
  }

  // ── Wake lock ──────────────────────────────────────────────────────────────

  async function acquireWakeLock() {
    try {
      if ('wakeLock' in navigator) {
        S.wakeLock = await navigator.wakeLock.request('screen');
      }
    } catch (err) { S.wakeLock = null; }
    paintAwakeDot();
  }
  function releaseWakeLock() {
    try { if (S.wakeLock) S.wakeLock.release(); } catch (e) { /* gone anyway */ }
    S.wakeLock = null;
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && document.getElementById('stageMode')) acquireWakeLock();
  });
  function paintAwakeDot() {
    const el = document.getElementById('stgAwake');
    if (el) el.style.display = S.wakeLock ? 'inline-flex' : 'none';
  }

  // ── Open / close ───────────────────────────────────────────────────────────

  window.openStagePerform = function () {
    const sl = window._setlistDetailCache;
    if (!sl) { showToast('Open a setlist first.'); return; }
    const byId = new Map((sl.songs || []).map(s => [s.id, s]));
    S.sl = sl;
    S.ordered = (sl.song_ids || []).map(id => byId.get(id)).filter(Boolean);
    if (!S.ordered.length) { showToast('Add some songs first.'); return; }
    S.meta = (sl.stage_meta && typeof sl.stage_meta === 'object') ? sl.stage_meta : {};
    S.meta.breaks = S.meta.breaks || [];
    S.meta.markers = S.meta.markers || [];
    S.meta.notes = S.meta.notes || {};
    S.meta.speeds = S.meta.speeds || {};
    S.meta.transpose = S.meta.transpose || {};
    S.index = 0;
    S.startedAt = Date.now();

    const wrap = document.createElement('div');
    wrap.id = 'stageMode';
    // Full-bleed black, but the CONTENT column caps at a readable width on
    // desktop/tablet; phones use the full width. Safe-area padding keeps the
    // header clear of the notch and the next-up bar clear of the iPhone
    // home indicator when installed as a PWA.
    wrap.style.cssText = 'position:fixed;inset:0;z-index:999999;background:#000;color:#E6EDF3;display:flex;flex-direction:column;align-items:center;font-family:-apple-system,BlinkMacSystemFont,sans-serif;overscroll-behavior:none;padding-top:env(safe-area-inset-top, 0px);padding-bottom:env(safe-area-inset-bottom, 0px);';
    document.body.appendChild(wrap);
    document.body.style.overflow = 'hidden';
    renderStage();
    acquireWakeLock();
    S.clockTimer = setInterval(paintClock, 1000);
    document.addEventListener('keydown', stageKeys);
  };

  window.closeStagePerform = function () {
    const el = document.getElementById('stageMode');
    if (el) el.remove();
    document.body.style.overflow = '';
    stopScroll();
    releaseWakeLock();
    clearInterval(S.clockTimer);
    document.removeEventListener('keydown', stageKeys);
  };

  // ── Render ─────────────────────────────────────────────────────────────────

  function fmtClock(ms) {
    const s = Math.floor(ms / 1000);
    return String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
  }

  function paintClock() {
    const el = document.getElementById('stgClock');
    if (!el) return;
    const elapsed = Date.now() - S.startedAt;
    el.textContent = fmtClock(elapsed);
    // Amber overrun: elapsed beyond the whole set's planned minutes.
    const set = setOfIndex(S.index);
    const planned = S.ordered.slice(set.start, set.end).reduce((a, x) => a + songSecs(x.duration), 0);
    el.style.color = planned && elapsed > planned * 1000 ? 'var(--accent, #F0A500)' : '#6E7681';
  }

  function renderStage() {
    const wrap = document.getElementById('stageMode');
    if (!wrap) return;
    stopScroll();
    const song = S.ordered[S.index];
    const set = setOfIndex(S.index);
    const semis = Number(S.meta.transpose[song.id]) || 0;
    const keyShown = song.key ? transposeChord(song.key, semis) : null;
    const next = S.ordered[S.index + 1];
    const nextSet = next ? setOfIndex(S.index + 1) : null;
    const nextKey = next && next.key ? transposeChord(next.key, Number(S.meta.transpose[next.id]) || 0) : null;
    const marker = (S.meta.markers || []).find(m => m && m.after === S.index - 1);
    const note = S.meta.notes[song.id];
    const bpm = Number(song.tempo) || null;
    const lyr = renderChordProHtml(song.lyrics, semis);
    const fs = S.fontScale;

    wrap.innerHTML = `
      <style>
        #stageMode > div, #stageMode > #stgJump { width:100%; max-width:760px; }
        #stageMode .stg-sec{font-size:${11 * fs}px;color:#6E7681;letter-spacing:1px;margin-top:10px;font-weight:700;}
        #stageMode #stgLyr b{color:var(--accent,#F0A500);font-weight:800;font-size:${14 * fs}px;vertical-align:super;margin-right:2px;}
        #stageMode .stg-pulse{display:inline-block;width:8px;height:8px;border-radius:50%;background:var(--accent,#F0A500);margin-left:6px;${bpm ? 'animation:stgbeat ' + (60 / bpm).toFixed(3) + 's infinite;' : 'display:none;'}}
        @keyframes stgbeat{0%,100%{opacity:.15;transform:scale(.8);}50%{opacity:1;transform:scale(1.15);}}
      </style>
      <div style="display:flex;align-items:center;justify-content:space-between;padding:14px 16px 0;flex-shrink:0;">
        <span onclick="stageJumpGrid()" style="font-size:12px;font-weight:800;color:var(--accent,#F0A500);letter-spacing:.8px;cursor:pointer;">SET ${set.num}${set.count > 1 ? ' / ' + set.count : ''} · ${S.index - set.start + 1} OF ${set.end - set.start} ▾</span>
        <span style="display:flex;align-items:center;gap:10px;">
          <span onclick="stageFont(-1)" style="font-size:12px;color:#8B949E;cursor:pointer;padding:4px;">A−</span>
          <span onclick="stageFont(1)" style="font-size:15px;color:#8B949E;cursor:pointer;padding:4px;">A+</span>
          <span id="stgAwake" style="display:none;align-items:center;gap:5px;font-size:10px;color:#3FB950;"><i style="width:6px;height:6px;border-radius:50%;background:#3FB950;display:inline-block;"></i>awake</span>
          <span id="stgClock" style="font-size:12px;color:#6E7681;font-variant-numeric:tabular-nums;">00:00</span>
          <span onclick="closeStagePerform()" style="font-size:18px;color:#8B949E;cursor:pointer;padding:2px 4px;">✕</span>
        </span>
      </div>
      ${marker ? `<div style="margin:10px 16px 0;background:rgba(240,165,0,.14);border:1px solid rgba(240,165,0,.5);border-radius:10px;padding:9px 12px;font-size:${14 * fs}px;font-weight:800;color:var(--accent,#F0A500);flex-shrink:0;">📣 ${escapeHtml(marker.text)}</div>` : ''}
      <div style="padding:8px 16px 0;flex-shrink:0;">
        <div style="font-size:${30 * fs}px;font-weight:800;line-height:1.12;">${escapeHtml(song.title)}</div>
        <div style="font-size:${15 * fs}px;color:#8B949E;margin-top:3px;">${escapeHtml([song.artist, bpm ? bpm + 'bpm' : '', songLen(song.duration)].filter(Boolean).join(' · '))}${bpm ? '<span class="stg-pulse"></span>' : ''}</div>
        ${note ? `<div style="font-size:${14 * fs}px;font-weight:800;color:var(--accent,#F0A500);margin-top:6px;">⚠ ${escapeHtml(note)}</div>` : ''}
        <div style="margin-top:8px;display:flex;align-items:center;gap:8px;">
          ${keyShown ? `
          <span style="display:inline-flex;align-items:center;gap:8px;font-size:${14 * fs}px;font-weight:800;color:#58A6FF;background:rgba(88,166,255,.12);border-radius:8px;padding:4px 10px;">
            <span onclick="stageTranspose(-1)" style="cursor:pointer;padding:0 4px;">♭</span>
            Key: ${escapeHtml(keyShown)}${semis ? ' <span style="font-weight:600;font-size:11px;">(' + (semis > 0 ? '+' : '') + semis + ')</span>' : ''}
            <span onclick="stageTranspose(1)" style="cursor:pointer;padding:0 4px;">♯</span>
            ${semis ? `<span onclick="stageTranspose(0)" style="cursor:pointer;font-size:10px;color:#8B949E;">reset</span>` : ''}
          </span>` : ''}
        </div>
      </div>
      <div id="stgLyr" onclick="toggleStageScroll(false)" style="flex:1;overflow-y:auto;padding:12px 16px 30px;font-size:${17 * fs}px;line-height:1.85;-webkit-overflow-scrolling:touch;">
        ${lyr || '<div style="color:#6E7681;font-size:15px;margin-top:20px;">No chart saved for this song. Add lyrics or ChordPro in Repertoire and they appear here.</div>'}
      </div>
      <div style="flex-shrink:0;padding:8px 16px 18px;">
        ${lyr ? `
        <div style="display:flex;align-items:center;gap:10px;background:#161B22;border:1px solid #30363D;border-radius:999px;padding:6px 12px;margin-bottom:8px;">
          <span id="stgPlay" onclick="toggleStageScroll(true)" style="width:30px;height:30px;border-radius:50%;background:var(--accent,#F0A500);color:#000;display:flex;align-items:center;justify-content:center;font-size:13px;font-weight:800;cursor:pointer;flex-shrink:0;">▶</span>
          <span style="font-size:11px;color:#8B949E;flex-shrink:0;">Auto-scroll</span>
          <span onclick="stageSpeed(-1)" style="font-size:16px;color:#8B949E;cursor:pointer;padding:0 8px;">−</span>
          <span id="stgSpeedLabel" style="flex:1;text-align:center;font-size:11px;color:#8B949E;"></span>
          <span onclick="stageSpeed(1)" style="font-size:16px;color:#8B949E;cursor:pointer;padding:0 8px;">+</span>
        </div>` : ''}
        <div onclick="stageGo(1)" style="background:#161B22;border:1px solid #30363D;border-radius:10px;padding:10px 12px;font-size:13px;color:#8B949E;display:flex;justify-content:space-between;cursor:pointer;">
          <span>${next ? (nextSet && nextSet.num !== set.num ? 'Next · SET ' + nextSet.num : 'Next up') : 'That’s the show'}</span>
          <b style="color:#E6EDF3;">${next ? escapeHtml([next.title, nextKey, next.tempo ? next.tempo + 'bpm' : ''].filter(Boolean).join(' · ')) : '🎉'}</b>
        </div>
      </div>`;

    initStageGestures();
    initScrollDefaults(song);
    paintClock();
    paintAwakeDot();
  }

  // ── Navigation ─────────────────────────────────────────────────────────────

  window.stageGo = function (delta) {
    const n = S.index + delta;
    if (n < 0 || n >= S.ordered.length) return;
    S.index = n;
    renderStage();
  };

  window.stageJumpGrid = function () {
    const wrap = document.getElementById('stageMode');
    if (!wrap || document.getElementById('stgJump')) return;
    const sets = setsOf();
    const grid = document.createElement('div');
    grid.id = 'stgJump';
    grid.style.cssText = 'position:absolute;inset:0;background:rgba(0,0,0,.92);z-index:10;overflow-y:auto;padding:20px 16px;';
    grid.innerHTML = sets.map((b, si) => `
      <div style="font-size:11px;font-weight:800;color:var(--accent,#F0A500);letter-spacing:.8px;margin:14px 0 6px;">SET ${si + 1}</div>
      ${S.ordered.slice(b[0], b[1]).map((s, i) => `
        <div onclick="stageJumpTo(${b[0] + i})" style="padding:11px 12px;border-radius:10px;margin-bottom:4px;font-size:15px;font-weight:600;cursor:pointer;${b[0] + i === S.index ? 'background:rgba(240,165,0,.16);color:var(--accent,#F0A500);' : 'background:#161B22;'}">${b[0] + i + 1}. ${escapeHtml(s.title)} <span style="font-size:11px;color:#8B949E;font-weight:400;">${escapeHtml(s.key || '')}</span></div>`).join('')}
    `).join('') + '<div onclick="document.getElementById(\'stgJump\').remove()" style="text-align:center;color:#8B949E;font-size:13px;padding:16px;cursor:pointer;">Close</div>';
    wrap.appendChild(grid);
  };

  window.stageJumpTo = function (i) {
    const j = document.getElementById('stgJump');
    if (j) j.remove();
    S.index = i;
    renderStage();
  };

  function stageKeys(e) {
    if (!document.getElementById('stageMode')) return;
    if (e.key === 'ArrowRight' || e.key === 'PageDown') { e.preventDefault(); stageGo(1); }
    else if (e.key === 'ArrowLeft' || e.key === 'PageUp') { e.preventDefault(); stageGo(-1); }
    else if (e.key === ' ') { e.preventDefault(); toggleStageScroll(); }
    else if (e.key === 'Escape') closeStagePerform();
  }

  function initStageGestures() {
    const wrap = document.getElementById('stageMode');
    if (!wrap) return;
    let sx = 0, sy = 0, dist0 = 0;
    wrap.addEventListener('touchstart', (e) => {
      if (e.touches.length === 2) {
        dist0 = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
      } else {
        sx = e.touches[0].clientX; sy = e.touches[0].clientY;
      }
    }, { passive: true });
    wrap.addEventListener('touchmove', (e) => {
      if (e.touches.length === 2 && dist0) {
        const d = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
        if (Math.abs(d - dist0) > 30) {
          stageFont(d > dist0 ? 1 : -1);
          dist0 = d;
        }
      }
    }, { passive: true });
    wrap.addEventListener('touchend', (e) => {
      if (dist0) { dist0 = 0; return; }
      const dx = e.changedTouches[0].clientX - sx;
      const dy = e.changedTouches[0].clientY - sy;
      if (Math.abs(dx) > 70 && Math.abs(dy) < 60) stageGo(dx < 0 ? 1 : -1);
    }, { passive: true });
  }

  window.stageFont = function (dir) {
    S.fontScale = Math.min(1.8, Math.max(0.7, S.fontScale + dir * 0.1));
    localStorage.setItem('tmg_stage_font', String(S.fontScale));
    renderStage();
  };

  // ── Transpose ──────────────────────────────────────────────────────────────

  window.stageTranspose = function (dir) {
    const song = S.ordered[S.index];
    if (dir === 0) delete S.meta.transpose[song.id];
    else {
      const cur = Number(S.meta.transpose[song.id]) || 0;
      let next = cur + dir;
      if (next > 11) next -= 12;
      if (next < -11) next += 12;
      if (next === 0) delete S.meta.transpose[song.id];
      else S.meta.transpose[song.id] = next;
    }
    saveMetaDebounced();
    renderStage();
  };

  // ── Auto-scroll ────────────────────────────────────────────────────────────

  function initScrollDefaults(song) {
    const el = document.getElementById('stgLyr');
    if (!el) return;
    const saved = Number(S.meta.speeds[song.id]);
    if (saved > 0) { S.scroll.speed = saved; }
    else {
      // Land the last line just before the song ends, with a 15s lead-out.
      const secs = Math.max(60, (songSecs(song.duration) || 210) - 15);
      const dist = Math.max(0, el.scrollHeight - el.clientHeight);
      S.scroll.speed = dist > 0 ? Math.max(4, dist / secs) : 12;
    }
    paintSpeedLabel();
  }

  function paintSpeedLabel() {
    const el = document.getElementById('stgSpeedLabel');
    if (el) el.textContent = S.scroll.on ? Math.round(S.scroll.speed) + ' px/s' : 'tap ▶ to roll';
    const play = document.getElementById('stgPlay');
    if (play) play.textContent = S.scroll.on ? '⏸' : '▶';
  }

  function scrollTick(ts) {
    if (!S.scroll.on) return;
    const el = document.getElementById('stgLyr');
    if (!el) { stopScroll(); return; }
    if (!S.scroll.last) S.scroll.last = ts;
    const dt = (ts - S.scroll.last) / 1000;
    S.scroll.last = ts;
    el.scrollTop += S.scroll.speed * dt;
    if (el.scrollTop + el.clientHeight >= el.scrollHeight - 2) { stopScroll(); return; }
    S.scroll.raf = requestAnimationFrame(scrollTick);
  }

  function stopScroll() {
    S.scroll.on = false;
    S.scroll.last = 0;
    cancelAnimationFrame(S.scroll.raf);
    paintSpeedLabel();
  }

  window.toggleStageScroll = function (fromButton) {
    // Lyric taps only PAUSE (never start) so a stray tap mid-song is safe.
    if (S.scroll.on) { stopScroll(); return; }
    if (fromButton !== true) return;
    S.scroll.on = true;
    S.scroll.last = 0;
    S.scroll.raf = requestAnimationFrame(scrollTick);
    paintSpeedLabel();
  };

  window.stageSpeed = function (dir) {
    S.scroll.speed = Math.max(2, Math.min(200, S.scroll.speed * (dir > 0 ? 1.15 : 0.87)));
    const song = S.ordered[S.index];
    S.meta.speeds[song.id] = Math.round(S.scroll.speed * 10) / 10;
    saveMetaDebounced();
    paintSpeedLabel();
  };
})();
