'use strict';
// New JS
/* ═══════════════════════════════════════════════════════════════════
   SUPABASE  ── client setup
═══════════════════════════════════════════════════════════════════ */
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';

const SUPA_URL  = 'https://ynpbtnvyfovehczevifh.supabase.co';
const SUPA_KEY  = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InlucGJ0bnZ5Zm92ZWhjemV2aWZoIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzk1ODk4NjgsImV4cCI6MjA5NTE2NTg2OH0.tuZLJ74_30wSSbLwfUrwaKhPrXVpxGfUtgC7qlovTOE';
const supa      = createClient(SUPA_URL, SUPA_KEY);

/* current auth session */
let _session = null;   // Supabase session or null
let _profile = null;   // { username, preferred_source, autoplay_next, … }

/* ═══════════════════════════════════════════════════════════════════
   CONFIG  ── fetched from Supabase Edge Function at boot
═══════════════════════════════════════════════════════════════════ */
let TMDB_TOKEN = '';   // populated by loadConfig()

async function loadConfig() {
  try {
    const res = await fetch(`${SUPA_URL}/functions/v1/get-config`, {
      headers: { 'apikey': SUPA_KEY },
    });
    if (!res.ok) throw new Error(`Config fetch failed: ${res.status}`);
    const cfg = await res.json();
    if (!cfg.tmdb_token) throw new Error('tmdb_token missing from config');
    TMDB_TOKEN = cfg.tmdb_token;
    if (cfg.os_key) OS_KEY = cfg.os_key;   // OpenSubtitles API key (optional)
  } catch (err) {
    console.error('JasTV: could not load config –', err.message);
    document.body.innerHTML = `<div style="display:flex;align-items:center;justify-content:center;
      height:100vh;flex-direction:column;gap:16px;background:#07070f;color:#F0EAD6;font-family:'Cinzel',Georgia,serif">
      <div style="font-size:48px">⚠️</div>
      <div style="font-size:20px;font-weight:800;letter-spacing:.18em;text-transform:uppercase;color:#C9A84C">Failed to Load</div>
      <div style="font-size:13px;color:#8A8070;max-width:400px;text-align:center;line-height:1.8;font-family:sans-serif">
        Could not reach the config service. Check your internet connection or Supabase Edge Function status.
      </div>
      <button onclick="location.reload()" style="background:#C9A84C;color:#07070f;padding:12px 32px;
        border-radius:4px;font-size:12px;font-weight:800;border:none;cursor:pointer;margin-top:8px;
        letter-spacing:.2em;text-transform:uppercase;font-family:'Cinzel',Georgia,serif">
        ↺ Retry
      </button>
    </div>`;
    throw err;
  }
}
const TMDB = 'https://api.themoviedb.org/3';
const IMG  = 'https://image.tmdb.org/t/p';

const posterUrl   = p => p ? `${IMG}/w342${p}`    : 'https://placehold.co/342x513/1a1a1a/555?text=?';
const backdropUrl = p => p ? `${IMG}/w1280${p}`   : '';
const bigBdUrl    = p => p ? `${IMG}/original${p}`: '';

function fmtTs(s) {
  s = Math.floor(s);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

/* ═══════════════════════════════════════════════════════════════════
   PROGRESS / RECENTS  ── cloud when logged in, localStorage fallback
═══════════════════════════════════════════════════════════════════ */
const sk       = (mt, id) => `jm_${mt}_${id}`;
const RKEY     = 'jm_recents';
const MAX_RECS = 24;

function _localSaveProgress(entry) {
  try {
    localStorage.setItem(sk(entry.mediaType, entry.tmdbId), JSON.stringify(entry));
    let list = JSON.parse(localStorage.getItem(RKEY) || '[]');
    list = list.filter(([mt, id]) => !(mt === entry.mediaType && id === entry.tmdbId));
    list.unshift([entry.mediaType, entry.tmdbId]);
    localStorage.setItem(RKEY, JSON.stringify(list.slice(0, MAX_RECS)));
  } catch (_) {}
}
function _localGetProgress(mt, id) {
  try { return JSON.parse(localStorage.getItem(sk(mt, id))); } catch (_) { return null; }
}
function _localGetRecents() {
  try {
    return JSON.parse(localStorage.getItem(RKEY) || '[]')
      .map(([mt, id]) => _localGetProgress(mt, id)).filter(Boolean);
  } catch (_) { return []; }
}

async function _cloudSaveProgress(entry) {
  if (!_session) return;
  const uid = _session.user.id;

  // Build payload WITHOUT watch_timestamp when we don't have a real position.
  // Supabase upsert only updates columns that are in the payload, so omitting
  // watch_timestamp on an UPDATE means the existing cloud value is preserved —
  // preventing "start playback with no local data" from wiping cloud progress.
  const payload = {
    user_id:     uid,
    tmdb_id:     entry.tmdbId,
    media_type:  entry.mediaType,
    title:       entry.title    || '',
    poster_path: entry.posterPath || null,
    season:      entry.season   || 1,
    episode:     entry.episode  || 1,
  };
  if (entry.watchTimestamp > 0) {
    payload.watch_timestamp = entry.watchTimestamp;
  }

  await supa.from('watch_progress').upsert(payload, { onConflict: 'user_id,tmdb_id,media_type' });
}
async function _cloudGetRecents() {
  if (!_session) return [];
  const { data } = await supa.from('watch_progress')
    .select('*')
    .eq('user_id', _session.user.id)
    .order('updated_at', { ascending: false })
    .limit(MAX_RECS);
  if (!data) return [];
  return data.map(r => ({
    tmdbId:         r.tmdb_id,
    mediaType:      r.media_type,
    title:          r.title,
    posterPath:     r.poster_path,
    season:         r.season,
    episode:        r.episode,
    watchTimestamp: r.watch_timestamp,
    updatedAt:      new Date(r.updated_at).getTime(),
  }));
}
async function _cloudGetProgress(mt, id) {
  if (!_session) return null;
  const { data } = await supa.from('watch_progress')
    .select('*')
    .eq('user_id',    _session.user.id)
    .eq('tmdb_id',    id)
    .eq('media_type', mt)
    .maybeSingle();
  if (!data) return null;
  return {
    tmdbId:         data.tmdb_id,
    mediaType:      data.media_type,
    title:          data.title,
    posterPath:     data.poster_path,
    season:         data.season,
    episode:        data.episode,
    watchTimestamp: data.watch_timestamp,
  };
}

async function saveProgress(entry) {
  _localSaveProgress(entry);
  await _cloudSaveProgress(entry);
}
async function getProgress(mt, id) {
  if (_session) return _cloudGetProgress(mt, id);
  return _localGetProgress(mt, id);
}
async function getRecents() {
  if (_session) return _cloudGetRecents();
  return _localGetRecents();
}

/* ═══════════════════════════════════════════════════════════════════
   FAVORITES  ── cloud when logged in, localStorage fallback
═══════════════════════════════════════════════════════════════════ */
const FAV_KEY = 'jm_favorites';

function _localGetFavorites() {
  try { return JSON.parse(localStorage.getItem(FAV_KEY) || '[]'); } catch (_) { return []; }
}
function _localSetFavorites(list) {
  try { localStorage.setItem(FAV_KEY, JSON.stringify(list)); } catch (_) {}
}
function _localIsFavorite(mt, id) {
  return _localGetFavorites().some(f => f.tmdbId === id && f.mediaType === mt);
}
function _localToggleFavorite(entry) {
  let list = _localGetFavorites();
  const idx = list.findIndex(f => f.tmdbId === entry.tmdbId && f.mediaType === entry.mediaType);
  if (idx >= 0) { list.splice(idx, 1); _localSetFavorites(list); return false; }
  list.unshift(entry); _localSetFavorites(list); return true;
}

async function isFavorite(mt, id) {
  if (_session) {
    const { data } = await supa.from('favorites')
      .select('id').eq('user_id', _session.user.id)
      .eq('tmdb_id', id).eq('media_type', mt).maybeSingle();
    return !!data;
  }
  return _localIsFavorite(mt, id);
}

async function toggleFavorite(entry) {
  if (_session) {
    const uid = _session.user.id;
    const { data } = await supa.from('favorites')
      .select('id').eq('user_id', uid)
      .eq('tmdb_id', entry.tmdbId).eq('media_type', entry.mediaType).maybeSingle();
    if (data) {
      await supa.from('favorites').delete().eq('id', data.id);
      _localToggleFavorite(entry);
      return false;
    } else {
      await supa.from('favorites').insert({
        user_id:     uid,
        tmdb_id:     entry.tmdbId,
        media_type:  entry.mediaType,
        title:       entry.title || '',
        poster_path: entry.posterPath || null,
      });
      _localToggleFavorite(entry);
      return true;
    }
  }
  return _localToggleFavorite(entry);
}

async function getFavorites() {
  if (_session) {
    const { data } = await supa.from('favorites')
      .select('*').eq('user_id', _session.user.id)
      .order('created_at', { ascending: false });
    if (!data) return [];
    return data.map(r => ({
      tmdbId:    r.tmdb_id,
      mediaType: r.media_type,
      title:     r.title,
      posterPath:r.poster_path,
    }));
  }
  return _localGetFavorites();
}


async function tmdb(path, params = {}) {
  const qs  = new URLSearchParams({ language: 'en-US', ...params }).toString();
  const res = await fetch(`${TMDB}${path}?${qs}`, {
    headers: { Authorization: `Bearer ${TMDB_TOKEN}`, Accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`TMDB ${res.status}: ${res.statusText}`);
  return res.json();
}

/* ═══════════════════════════════════════════════════════════════════
   TV-REMOTE SPATIAL NAVIGATION
═══════════════════════════════════════════════════════════════════ */
let $f = null;

function setFocus(el, doScroll = true) {
  if (!el || el === $f) return;
  $f?.classList.remove('focused');
  $f = el;
  $f.classList.add('focused');
  if (doScroll) $f.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
}

function focusFirst(root = document) {
  const el = root.querySelector('.focusable');
  if (el) setFocus(el, false);
}

function spatialNav(dir) {
  if (!$f) { focusFirst(); return; }

  // ── Fast-path: TV row navigation on the home screen ─────────────────
  // The home screen can have 600+ .focusable elements. Calling
  // getBoundingClientRect() on all of them on every keypress is O(n·reflow)
  // and completely freezes GeckoView on TV hardware.
  // Use DOM structure instead: left/right = siblings, up/down = row hops.
  if (active === 'home') {
    const strip = $f.closest('.row-strip');
    if (strip) {
      if (dir === 'left' || dir === 'right') {
        const cards = [...strip.querySelectorAll('.focusable')];
        const idx = cards.indexOf($f);
        const next = dir === 'right' ? cards[idx + 1] : cards[idx - 1];
        if (next) { setFocus(next); return; }
        return; // at strip edge — don't wrap
      }
      if (dir === 'up' || dir === 'down') {
        const currentRow = strip.closest('.cat-row');
        const homeScroll = document.getElementById('home-scroll');
        if (homeScroll && currentRow) {
          const rows = [...homeScroll.querySelectorAll('.cat-row')];
          const rowIdx = rows.indexOf(currentRow);
          const delta = dir === 'down' ? 1 : -1;
          for (let i = rowIdx + delta; i >= 0 && i < rows.length; i += delta) {
            const f = rows[i].querySelector('.focusable');
            if (f) { setFocus(f); return; }
          }
          if (dir === 'up') {
            const heroBtn = document.getElementById('btn-hero-play');
            if (heroBtn) { setFocus(heroBtn); return; }
          }
        }
        return;
      }
    }
    // Focus is on hero/nav buttons — down goes to first row card
    if (dir === 'down') {
      const firstCard = document.querySelector('#home-scroll .cat-row .focusable');
      if (firstCard) { setFocus(firstCard); return; }
    }
    if (dir === 'up') return; // already at top
    // left/right between hero buttons: fall through to generic nav below
  }

  // ── Generic spatial nav for non-home views ───────────────────────────
  // Scoped to the active view only (avoids crossing hidden views).
  const W = window.innerWidth, H = window.innerHeight;
  const scope = document.getElementById('view-' + active) ?? document;
  const all = [...scope.querySelectorAll('.focusable')].filter(el => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 &&
           r.top < H + 80 && r.bottom > -80 &&
           r.left < W + 80 && r.right > -80;
  });
  const fr = $f.getBoundingClientRect();
  const cx = fr.left + fr.width / 2;
  const cy = fr.top  + fr.height / 2;
  let best = null, bestScore = Infinity;
  for (const c of all) {
    if (c === $f) continue;
    const cr = c.getBoundingClientRect();
    const ex = cr.left + cr.width  / 2;
    const ey = cr.top  + cr.height / 2;
    const dx = ex - cx, dy = ey - cy;
    const valid =
      (dir === 'up'    && dy < -4) ||
      (dir === 'down'  && dy >  4) ||
      (dir === 'left'  && dx < -4) ||
      (dir === 'right' && dx >  4);
    if (!valid) continue;
    const pri = (dir === 'up' || dir === 'down') ? Math.abs(dy) : Math.abs(dx);
    const sec = (dir === 'up' || dir === 'down') ? Math.abs(dx) : Math.abs(dy);
    if (pri + sec * 2.5 < bestScore) { bestScore = pri + sec * 2.5; best = c; }
  }
  if (best) setFocus(best);
}

/* ── Player bar auto-hide ────────────────────────────────────────────────
   The bar fades out 3.5 s after the last keypress during playback.
   Any keypress (D-pad, Enter, Back) resets the timer and shows the bar.
   ──────────────────────────────────────────────────────────────────────── */
let _barHideTimer = null;

function _isFullscreen() {
  return !!(document.fullscreenElement ||
            document.webkitFullscreenElement ||
            document.mozFullScreenElement);
}

function _showPlayerBar() {
  const bar = document.getElementById('player-bar');
  if (!bar) return;
  bar.classList.remove('bar-hidden');
  clearTimeout(_barHideTimer);
  // Only auto-hide when the browser is actually in fullscreen
  if (_isFullscreen()) {
    _barHideTimer = setTimeout(() => {
      const b = document.getElementById('player-bar');
      if (b && active === 'player' && _isFullscreen()) b.classList.add('bar-hidden');
    }, 3500);
  }
}

function _clearPlayerBar() {
  clearTimeout(_barHideTimer);
  _barHideTimer = null;
  const bar = document.getElementById('player-bar');
  if (bar) bar.classList.remove('bar-hidden');
}

// When entering fullscreen: start the hide timer.
// When exiting fullscreen: cancel timer and permanently show bar.
['fullscreenchange','webkitfullscreenchange','mozfullscreenchange'].forEach(evt => {
  document.addEventListener(evt, () => {
    if (active !== 'player') return;
    if (_isFullscreen()) {
      _showPlayerBar(); // starts the hide timer
    } else {
      _clearPlayerBar(); // exits fullscreen → bar stays visible always
    }
  });
});

document.addEventListener('keydown', e => {
  // While in player: show bar on every keypress and reset hide timer.
  // (Escape/Back falls through to goBack() below as normal.)
  if (active === 'player') _showPlayerBar();

  if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') {
    if (e.key === 'Escape') { e.preventDefault(); goBack(); }
    return;
  }
  switch (e.key) {
    case 'ArrowUp':                  e.preventDefault(); spatialNav('up');    break;
    case 'ArrowDown':                e.preventDefault(); spatialNav('down');  break;
    case 'ArrowLeft':                e.preventDefault(); spatialNav('left');  break;
    case 'ArrowRight':               e.preventDefault(); spatialNav('right'); break;
    case 'Enter':                    e.preventDefault(); $f?.click();          break;
    case 'Escape': case 'Backspace':
    case 'GoBack':                   e.preventDefault(); goBack();             break;
  }
});

/* ═══════════════════════════════════════════════════════════════════
   ROUTER
═══════════════════════════════════════════════════════════════════ */
const navStack = [];
let   active   = 'home';
let   _justExitedPlayer = false;

function showView(id) {
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.getElementById('view-' + id)?.classList.add('active');
  active = id;
}

function navigateTo(id, renderFn) {
  navStack.push(active);
  showView(id);
  $f = null;
  renderFn?.();
  requestAnimationFrame(() => focusFirst(document.getElementById('view-' + id)));
}

/* ── Android GeckoView back-button hook ──────────────────────────────────
   MainActivity injects a synthetic Escape key when the Fire TV BACK button
   is pressed.  The keydown handler calls goBack() which either pops the JS
   navStack (normal navigation) or shows a hint when already at home screen.
   ──────────────────────────────────────────────────────────────────────── */
let _backHintShown = false, _backHintTimer = null;

function goBack() {
  if (!navStack.length) {
    if (!_backHintShown) {
      _backHintShown = true;
      showToast('Press ⌂ Home to exit the app', 'neutral');
      clearTimeout(_backHintTimer);
      _backHintTimer = setTimeout(() => { _backHintShown = false; }, 3200);
    }
    return;
  }
  const prev = navStack.pop();
  if (active === 'player') killPlayer();
  showView(prev);
  $f = null;
  if (prev === 'home') {
    refreshContinueWatching();
    setTimeout(() => startHeroCycle(), 200);
  }
  requestAnimationFrame(() => focusFirst(document.getElementById('view-' + prev)));
}

function _hideCapLine() {
  // Stub: caption overlay is removed when frame-wrap is replaced by renderPlayer().
  // No separate DOM node to clean up unless captions are active.
  const cap = document.getElementById('cap-line');
  if (cap) cap.remove();
}

function killPlayer() {
  // ── Save final position before tearing down ──────────────────────
  _stopWatchClock();
  const finalTs = _watchCurrent();
  if (finalTs > 5 && _pl.id) {
    _pl.resumeTs = finalTs;
    saveProgress({
      tmdbId:         _pl.id,
      mediaType:      _pl.mediaType,
      title:          _pl.title,
      posterPath:     _pl.posterPath,
      season:         _pl.season,
      episode:        _pl.episode,
      watchTimestamp: finalTs,
      updatedAt:      Date.now(),
    });
  }
  clearStreamTimer();
  _clearPlayerBar();
  window.removeEventListener('message', onPlayerMsg);
  const f = document.getElementById('player-frame');
  if (f) f.src = 'about:blank';
  _justExitedPlayer = true;
  setTimeout(() => { _justExitedPlayer = false; }, 500);
  _hideCapLine();
}

/* ═══════════════════════════════════════════════════════════════════
   AUTH UI
═══════════════════════════════════════════════════════════════════ */
function updateNavAuth() {
  const signInBtn   = document.getElementById('btn-nav-signin');
  const userWrap    = document.getElementById('user-menu-wrap');
  const ddUsername  = document.getElementById('dropdown-username');

  if (_session) {
    signInBtn.style.display = 'none';
    userWrap.style.display  = 'flex';
    ddUsername.textContent  = _profile?.username
      ? '@' + _profile.username
      : _session.user.email;
  } else {
    signInBtn.style.display = '';
    userWrap.style.display  = 'none';
  }
}

let _toastTimer = null;
function showToast(msg, type = 'ok') {
  clearTimeout(_toastTimer);
  let t = document.getElementById('jm-toast');
  if (!t) {
    t = document.createElement('div');
    t.id = 'jm-toast';
    document.body.appendChild(t);
  }
  t.textContent = msg;
  t.className   = 'jm-toast-visible jm-toast-' + type;
  _toastTimer = setTimeout(() => { t.className = ''; }, 3000);
}

function openAuth() {
  navigateTo('auth', () => {
    switchAuthTab('login');
    switchLoginMode('password');
    clearAuthErrors();
    ['li-identifier','li-password','li-otp-email','li-otp-code',
     'reg-username','reg-email','reg-password'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.value = '';
    });
    document.getElementById('otp-step-email').classList.remove('hidden');
    document.getElementById('otp-step-code').classList.add('hidden');
  });
}

function switchAuthTab(tab) {
  document.querySelectorAll('.auth-tab').forEach(t =>
    t.classList.toggle('active', t.dataset.tab === tab));
  document.getElementById('auth-panel-login').classList.toggle('hidden', tab !== 'login');
  document.getElementById('auth-panel-register').classList.toggle('hidden', tab !== 'register');
}

function switchLoginMode(mode) {
  document.querySelectorAll('.mode-tab').forEach(t =>
    t.classList.toggle('active', t.dataset.mode === mode));
  document.getElementById('login-password-form').classList.toggle('hidden', mode !== 'password');
  document.getElementById('login-otp-form').classList.toggle('hidden', mode !== 'otp');
}

function clearAuthErrors() {
  ['auth-error-login','auth-error-register'].forEach(id => {
    const el = document.getElementById(id);
    el.textContent = '';
    el.classList.add('hidden');
  });
}
function showAuthError(panel, msg) {
  const el = document.getElementById(`auth-error-${panel}`);
  el.textContent = msg;
  el.classList.remove('hidden');
}
function setSubmitLoading(btn, loading, label) {
  btn.disabled = loading;
  btn.innerHTML = loading
    ? `<span class="spin-inline"></span> ${label}…`
    : label;
}

async function loadProfile(userId) {
  const { data } = await supa.from('profiles').select('*').eq('id', userId).maybeSingle();
  _profile = data;
}

async function onSignedIn(session) {
  _session = session;
  updateNavAuth();
  await loadProfile(session.user.id);
  updateNavAuth();
  if (active === 'auth') {
    showView('home');
    navStack.length = 0;
    refreshContinueWatching();
  }
  const name = _profile?.username ? `@${_profile.username}` : session.user.email;
  showToast(`✅ Welcome, ${name}!`);
}

async function handleSignOut() {
  await supa.auth.signOut();
  _session = null;
  _profile = null;
  updateNavAuth();
  closeDropdown();
  refreshContinueWatching();
  showToast('👋 Signed out.', 'neutral');
}

/* ── Register ── */
async function doRegister() {
  clearAuthErrors();
  const username = document.getElementById('reg-username').value.trim().toLowerCase();
  const email    = document.getElementById('reg-email').value.trim().toLowerCase();
  const password = document.getElementById('reg-password').value;
  const btn      = document.getElementById('btn-register');

  if (username.length < 6)
    return showAuthError('register', 'Username must be at least 6 characters.');
  if (!/^[a-z0-9_]+$/.test(username))
    return showAuthError('register', 'Username can only contain letters, numbers and underscores.');
  if (!email.includes('@'))
    return showAuthError('register', 'Enter a valid email address.');
  if (password.length < 6)
    return showAuthError('register', 'Password must be at least 6 characters.');

  setSubmitLoading(btn, true, 'Create Account');

  const { data: existingUser } = await supa
    .from('profiles').select('id')
    .ilike('username', username)
    .maybeSingle();
  if (existingUser) {
    setSubmitLoading(btn, false, 'Create Account');
    return showAuthError('register', 'That username is already taken.');
  }

  const { data: existingEmail } = await supa
    .from('profiles').select('id')
    .ilike('email', email)
    .maybeSingle();
  if (existingEmail) {
    setSubmitLoading(btn, false, 'Create Account');
    return showAuthError('register', 'An account with that email already exists. Try signing in instead.');
  }

  const { data, error } = await supa.auth.signUp({
    email, password,
    options: { data: { username } },
  });

  if (error) {
    setSubmitLoading(btn, false, 'Create Account');
    const msg = error.message.toLowerCase().includes('already registered') ||
                error.message.toLowerCase().includes('user already exists')
      ? 'An account with that email already exists. Try signing in instead.'
      : error.message;
    return showAuthError('register', msg);
  }

  if (data.user) {
    const { error: profErr } = await supa.from('profiles').upsert({
      id:       data.user.id,
      username: username,
      email:    email,
    }, { onConflict: 'id' });

    if (profErr) {
      if (profErr.message?.toLowerCase().includes('unique') || profErr.code === '23505') {
        setSubmitLoading(btn, false, 'Create Account');
        return showAuthError('register', 'That username was just taken — please choose another.');
      }
    }
  }

  setSubmitLoading(btn, false, 'Create Account');

  if (data.session) {
    await onSignedIn(data.session);
  } else {
    showAuthError('register',
      '✅ Account created! Check your email for a confirmation link, then sign in here.');
  }
}

/* ── Login by password (email or username) ── */
async function doLoginPassword() {
  clearAuthErrors();
  let identifier = document.getElementById('li-identifier').value.trim();
  const password = document.getElementById('li-password').value;
  const btn      = document.getElementById('btn-signin-pw');

  if (!identifier || !password) return showAuthError('login', 'Please fill in all fields.');

  setSubmitLoading(btn, true, 'Sign In');

  let email = identifier.toLowerCase();
  if (!identifier.includes('@')) {
    const { data: prof } = await supa
      .from('profiles')
      .select('email')
      .ilike('username', identifier.trim())
      .maybeSingle();
    if (!prof?.email) {
      setSubmitLoading(btn, false, 'Sign In');
      return showAuthError('login', 'No account found with that username. Try signing in with your email, or use Email OTP.');
    }
    email = prof.email;
  }

  const { data, error } = await supa.auth.signInWithPassword({ email, password });
  setSubmitLoading(btn, false, 'Sign In');
  if (error) {
    const msg = error.message.toLowerCase().includes('email not confirmed')
      ? 'Your email isn\'t confirmed yet. Check your inbox for the confirmation link.'
      : error.message;
    return showAuthError('login', msg);
  }
  await onSignedIn(data.session);
}

/* ── Forgot password ── */
async function doForgotPassword() {
  clearAuthErrors();
  const identifier = document.getElementById('li-identifier').value.trim();
  let email = identifier;

  if (!identifier) return showAuthError('login', 'Enter your email or username above first, then click Forgot Password.');

  if (!identifier.includes('@')) {
    const { data: prof } = await supa.from('profiles').select('email').ilike('username', identifier.trim()).maybeSingle();
    if (!prof?.email) return showAuthError('login', 'No account found with that username.');
    email = prof.email.toLowerCase();
  } else {
    email = identifier.toLowerCase();
  }

  const { error } = await supa.auth.resetPasswordForEmail(email, {
    redirectTo: window.location.href,
  });
  if (error) return showAuthError('login', error.message);
  const el = document.getElementById('auth-error-login');
  el.textContent = `✅ Password reset email sent to ${email}. Check your inbox.`;
  el.classList.remove('hidden');
  el.style.color = '#2ecc71';
}

/* ── Password reset form ── */
function openPasswordReset() {
  navigateTo('auth', () => {
    document.getElementById('auth-tabs').style.display = 'none';
    document.getElementById('auth-panel-login').classList.add('hidden');
    document.getElementById('auth-panel-register').classList.add('hidden');

    let panel = document.getElementById('auth-panel-reset');
    if (!panel) {
      panel = document.createElement('div');
      panel.id = 'auth-panel-reset';
      panel.className = 'auth-panel';
      panel.innerHTML = `
        <div class="auth-field-wrap">
          <label class="auth-label">New Password <span class="auth-hint-inline">(min. 6 characters)</span></label>
          <input id="reset-pw-new" class="auth-input focusable" type="password" tabindex="0"
                 placeholder="••••••••" autocomplete="new-password">
        </div>
        <div class="auth-field-wrap">
          <label class="auth-label">Confirm New Password</label>
          <input id="reset-pw-confirm" class="auth-input focusable" type="password" tabindex="0"
                 placeholder="••••••••" autocomplete="new-password">
        </div>
        <button id="btn-do-reset" class="auth-submit focusable" tabindex="0">Set New Password</button>
        <p id="auth-error-reset" class="auth-error hidden"></p>
      `;
      document.getElementById('auth-card').insertBefore(
        panel, document.getElementById('btn-auth-back'));
    }
    panel.classList.remove('hidden');

    document.getElementById('btn-do-reset').onclick = async () => {
      const np = document.getElementById('reset-pw-new').value;
      const cp = document.getElementById('reset-pw-confirm').value;
      const errEl = document.getElementById('auth-error-reset');
      errEl.classList.add('hidden');
      if (np.length < 6) { errEl.textContent = 'Password must be at least 6 characters.'; errEl.classList.remove('hidden'); return; }
      if (np !== cp)     { errEl.textContent = 'Passwords don\'t match.'; errEl.classList.remove('hidden'); return; }
      const btn = document.getElementById('btn-do-reset');
      setSubmitLoading(btn, true, 'Set New Password');
      const { error } = await supa.auth.updateUser({ password: np });
      setSubmitLoading(btn, false, 'Set New Password');
      if (error) { errEl.textContent = error.message; errEl.classList.remove('hidden'); return; }
      const { data: { session } } = await supa.auth.getSession();
      if (session) await onSignedIn(session);
      else { showView('home'); navStack.length = 0; showToast('✅ Password updated! Please sign in.'); }
    };
  });
}

let _otpEmail = '';
async function doSendOtp() {
  clearAuthErrors();
  const email = document.getElementById('li-otp-email').value.trim();
  const btn   = document.getElementById('btn-send-otp');
  if (!email.includes('@')) return showAuthError('login', 'Enter a valid email address.');
  _otpEmail = email;
  setSubmitLoading(btn, true, 'Send OTP');
  const { error } = await supa.auth.signInWithOtp({
    email,
    options: { shouldCreateUser: false, emailRedirectTo: undefined },
  });
  setSubmitLoading(btn, false, 'Send OTP');
  if (error) return showAuthError('login', error.message);
  document.getElementById('otp-step-email').classList.add('hidden');
  document.getElementById('otp-step-code').classList.remove('hidden');
  setTimeout(() => document.getElementById('li-otp-code')?.focus(), 80);
}

async function doVerifyOtp() {
  clearAuthErrors();
  const code = document.getElementById('li-otp-code').value.trim();
  const btn  = document.getElementById('btn-verify-otp');
  if (!code) return showAuthError('login', 'Enter the 6-digit code from your email.');
  setSubmitLoading(btn, true, 'Verify & Sign In');
  const { data, error } = await supa.auth.verifyOtp({ email: _otpEmail, token: code, type: 'email' });
  setSubmitLoading(btn, false, 'Verify & Sign In');
  if (error) return showAuthError('login', error.message);
  await onSignedIn(data.session);
}

/* ═══════════════════════════════════════════════════════════════════
   USER DROPDOWN
═══════════════════════════════════════════════════════════════════ */
let _dropdownOpen = false;

function toggleDropdown() {
  _dropdownOpen = !_dropdownOpen;
  document.getElementById('user-dropdown').classList.toggle('hidden', !_dropdownOpen);
}
function closeDropdown() {
  _dropdownOpen = false;
  document.getElementById('user-dropdown')?.classList.add('hidden');
}

/* ═══════════════════════════════════════════════════════════════════
   SETTINGS VIEW
═══════════════════════════════════════════════════════════════════ */
function openSettings() {
  closeDropdown();
  navigateTo('settings', renderSettings);
}

function renderSettings() {
  if (!_session || !_profile) return;
  const user = _session.user;
  document.getElementById('sett-username').textContent = '@' + _profile.username;
  document.getElementById('sett-email').textContent    = user.email || '—';
  document.getElementById('sett-since').textContent    =
    new Date(user.created_at).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
  hideSettingsMsg();
}

function showSettingsMsg(msg, type = 'ok') {
  const el = document.getElementById('settings-msg');
  el.textContent = msg;
  el.className   = `settings-msg ${type}`;
  el.classList.remove('hidden');
  setTimeout(() => el.classList.add('hidden'), 3500);
}
function hideSettingsMsg() {
  document.getElementById('settings-msg')?.classList.add('hidden');
}

async function saveSettings() {
  // placeholder
}

async function doClearHistory() {
  if (_session) {
    await supa.from('watch_progress').delete().eq('user_id', _session.user.id);
  }
  try {
    const toRemove = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && (k.startsWith('jm_movie_') || k.startsWith('jm_tv_') || k === RKEY)) toRemove.push(k);
    }
    toRemove.forEach(k => localStorage.removeItem(k));
  } catch (_) {}
  showSettingsMsg('✅ Watch history cleared.');
}

/* ═══════════════════════════════════════════════════════════════════
   HISTORY + FAVORITES VIEW
═══════════════════════════════════════════════════════════════════ */
let _histTab = 'history';

function openHistoryView(startTab = 'history') {
  _histTab = startTab;
  navigateTo('history', () => {
    document.getElementById('btn-history-back').onclick = goBack;
    document.querySelectorAll('.hist-tab').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.htab === _histTab);
      btn.addEventListener('click', () => {
        _histTab = btn.dataset.htab;
        document.querySelectorAll('.hist-tab').forEach(b =>
          b.classList.toggle('active', b.dataset.htab === _histTab));
        renderHistoryList();
      });
    });
    renderHistoryList();
  });
}

async function renderHistoryList() {
  const list  = document.getElementById('history-list');
  const title = document.getElementById('history-title');
  list.innerHTML = '<div class="spin-wrap"><div class="spinner"></div></div>';

  if (_histTab === 'history') {
    title.textContent = '📋 Watch History';
    const items = await getRecents();
    if (!items.length) { list.innerHTML = '<p class="placeholder">No watch history yet.</p>'; return; }
    list.innerHTML = items.map(w => `
      <div class="hist-item focusable" tabindex="0"
           data-action="open" data-id="${w.tmdbId}" data-type="${w.mediaType}"
           data-season="${w.season||1}" data-episode="${w.episode||1}"
           data-title="${a(w.title)}" data-poster="${a(w.posterPath||'')}">
        <img class="hist-poster" src="${posterUrl(w.posterPath)}" alt="${a(w.title)}">
        <div class="hist-info">
          <div class="hist-title">${h(w.title)}</div>
          <div class="hist-meta">${w.mediaType === 'tv' ? `S${w.season} E${w.episode}` : 'Movie'}${w.watchTimestamp > 0 ? ' · ' + fmtTs(w.watchTimestamp) : ''}</div>
        </div>
        <button class="hist-del focusable" tabindex="0"
                data-action="delete" data-id="${w.tmdbId}" data-type="${w.mediaType}"
                title="Remove from history">🗑</button>
      </div>`).join('');
  } else {
    title.textContent = '❤️ Favorites';
    const items = await getFavorites();
    if (!items.length) { list.innerHTML = '<p class="placeholder">No favorites yet. Heart a movie or show from its detail page!</p>'; return; }
    list.innerHTML = items.map(f => `
      <div class="hist-item focusable" tabindex="0"
           data-action="open" data-id="${f.tmdbId}" data-type="${f.mediaType}"
           data-title="${a(f.title)}" data-poster="${a(f.posterPath||'')}">
        <img class="hist-poster" src="${posterUrl(f.posterPath)}" alt="${a(f.title)}">
        <div class="hist-info">
          <div class="hist-title">${h(f.title)}</div>
          <div class="hist-meta">${f.mediaType === 'tv' ? 'TV Series' : 'Movie'}</div>
        </div>
        <button class="hist-del focusable" tabindex="0"
                data-action="unfav" data-id="${f.tmdbId}" data-type="${f.mediaType}"
                data-title="${a(f.title)}" data-poster="${a(f.posterPath||'')}"
                title="Remove from favorites">💔</button>
      </div>`).join('');
  }

  list._handler && list.removeEventListener('click', list._handler);
  list._handler = async e => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    e.stopPropagation();
    const { action, id, type, title, poster } = btn.dataset;
    if (action === 'open') {
      openDetail(+id, type);
    } else if (action === 'delete') {
      if (_session) {
        await supa.from('watch_progress').delete()
          .eq('user_id', _session.user.id).eq('tmdb_id', +id).eq('media_type', type);
      }
      try {
        localStorage.removeItem(sk(type, +id));
        let recs = JSON.parse(localStorage.getItem(RKEY) || '[]');
        recs = recs.filter(([mt, rid]) => !(mt === type && String(rid) === id));
        localStorage.setItem(RKEY, JSON.stringify(recs));
      } catch(_) {}
      renderHistoryList();
    } else if (action === 'unfav') {
      await toggleFavorite({ tmdbId: +id, mediaType: type, title, posterPath: poster });
      renderHistoryList();
    }
  };
  list.addEventListener('click', list._handler);
  requestAnimationFrame(() => setFocus(list.querySelector('.focusable'), false));
}

async function doResetData() {
  if (_session) {
    await supa.from('watch_progress').delete().eq('user_id', _session.user.id);
    await supa.from('favorites').delete().eq('user_id', _session.user.id);
  }
  try {
    const toRemove = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith('jm_')) toRemove.push(k);
    }
    toRemove.forEach(k => localStorage.removeItem(k));
  } catch (_) {}
  showSettingsMsg('✅ All data reset.');
}

async function doDeleteAccount() {
  if (!_session) return;
  await supa.from('profiles').delete().eq('id', _session.user.id);
  await supa.from('favorites').delete().eq('user_id', _session.user.id);
  await supa.auth.signOut();
  _session = null; _profile = null;
  try {
    const toRemove = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith('jm_')) toRemove.push(k);
    }
    toRemove.forEach(k => localStorage.removeItem(k));
  } catch (_) {}
  updateNavAuth();
  showView('home');
  navStack.length = 0;
  refreshContinueWatching();
}

function showConfirm(msg) {
  return new Promise(resolve => {
    document.getElementById('confirm-msg').textContent = msg;
    document.getElementById('confirm-overlay').classList.remove('hidden');
    const yes = document.getElementById('confirm-yes');
    const no  = document.getElementById('confirm-no');
    function cleanup(result) {
      document.getElementById('confirm-overlay').classList.add('hidden');
      yes.removeEventListener('click', onYes);
      no.removeEventListener('click',  onNo);
      resolve(result);
    }
    function onYes() { cleanup(true);  }
    function onNo()  { cleanup(false); }
    yes.addEventListener('click', onYes);
    no.addEventListener('click',  onNo);
    setFocus(no, false);
  });
}

/* ═══════════════════════════════════════════════════════════════════
   HOME SCREEN
═══════════════════════════════════════════════════════════════════ */
let homeLoaded = false;
let heroItem = null, heroType = 'movie';
let _heroItems = [], _heroIdx = 0, _heroTimer = null;

/* Build ★ star string from a 0–10 TMDB average */
function buildStars(avg) {
  const v = avg / 2;
  const full = Math.floor(v);
  const half = (v - full) >= 0.35 ? 1 : 0;
  const empty = 5 - full - half;
  return '★'.repeat(full) + (half ? '½' : '') + '☆'.repeat(empty);
}

function updateHero(item, idx) {
  if (active !== 'home') { heroItem = item; return; }
  heroItem = item;

  const hero = document.getElementById('hero');
  if (!hero) return;

  hero.classList.add('hero-changing');

  setTimeout(() => {
    const title = item.title || item.name || '';
    const year  = (item.release_date || item.first_air_date || '').slice(0, 4);
    const rat   = item.vote_average ? +item.vote_average.toFixed(1) : 0;
    const stars = rat ? buildStars(rat) : '';
    const bd    = backdropUrl(item.backdrop_path);

    const bgEl = document.getElementById('hero-bg');
    if (bgEl) { bgEl.src = bd; bgEl.alt = title; }

    const titleEl = document.getElementById('hero-title');
    if (titleEl) titleEl.textContent = title;

    const metaEl = document.getElementById('hero-meta');
    if (metaEl) metaEl.innerHTML =
      (stars ? `<span class="star-rating">${stars}</span>` : '') +
      (year  ? `<span>${h(year)}</span>` : '') +
      (rat   ? `<span>${h(rat.toFixed(1))} / 10</span>` : '');

    const descEl = document.getElementById('hero-desc');
    if (descEl) descEl.textContent = item.overview || '';

    const playBtn = document.getElementById('btn-hero-play');
    if (playBtn) {
      playBtn.dataset.id     = item.id;
      playBtn.dataset.type   = 'movie';
      playBtn.dataset.title  = title;
      playBtn.dataset.poster = item.poster_path || '';
    }
    const infoBtn = document.getElementById('btn-hero-info');
    if (infoBtn) { infoBtn.dataset.id = item.id; infoBtn.dataset.type = 'movie'; }

    document.querySelectorAll('.hero-dot').forEach((d, i) =>
      d.classList.toggle('active', i === idx));

    hero.classList.remove('hero-changing');
  }, 420);
}

function startHeroCycle() {
  stopHeroCycle();
  if (_heroItems.length <= 1) return;
  _heroTimer = setInterval(() => {
    _heroIdx = (_heroIdx + 1) % _heroItems.length;
    updateHero(_heroItems[_heroIdx], _heroIdx);
  }, 7000);
}
function stopHeroCycle() {
  if (_heroTimer) { clearInterval(_heroTimer); _heroTimer = null; }
}

async function initHome() {
  if (homeLoaded) return;
  homeLoaded = true;

  const scroll = document.getElementById('home-scroll');
  scroll.innerHTML = spinner();

  try {
    // ── Phase 1: 10 core rows — rendered immediately ─────────────────
    const [tr, pop, top, now, ptv, ttv, trtv, upc, air, onair] = await Promise.all([
      tmdb('/trending/movie/week'),
      tmdb('/movie/popular'),
      tmdb('/movie/top_rated'),
      tmdb('/movie/now_playing'),
      tmdb('/tv/popular'),
      tmdb('/tv/top_rated'),
      tmdb('/trending/tv/week'),
      tmdb('/movie/upcoming'),
      tmdb('/tv/airing_today'),
      tmdb('/tv/on_the_air'),
    ]);

    // Store up to 5 trending movies for the hero carousel
    _heroItems = (tr.results || []).slice(0, 5).filter(Boolean);
    _heroIdx   = 0;
    heroItem   = _heroItems[0] || pop.results[0];
    heroType   = 'movie';

    const cwHtml = await buildContinueWatching();

    scroll.innerHTML =
      buildHero(heroItem) +
      cwHtml +
      buildRow('Trending Now',       tr.results,    'movie', { path: '/trending/movie/week' }) +
      buildRow('Now Playing',        now.results,   'movie', { path: '/movie/now_playing' }) +
      buildRow('Coming Soon',        upc.results,   'movie', { path: '/movie/upcoming' }) +
      buildRow('Popular Movies',     pop.results,   'movie', { path: '/movie/popular' }) +
      buildRow('Top Rated Movies',   top.results,   'movie', { path: '/movie/top_rated' }) +
      buildRow('Popular TV Shows',   ptv.results,   'tv',    { path: '/tv/popular' }) +
      buildRow('Airing Today',       air.results,   'tv',    { path: '/tv/airing_today' }) +
      buildRow('Now on TV',          onair.results, 'tv',    { path: '/tv/on_the_air' }) +
      buildRow('Top Rated TV',       ttv.results,   'tv',    { path: '/tv/top_rated' }) +
      buildRow('Trending TV',        trtv.results,  'tv',    { path: '/trending/tv/week' }) +
      buildSectionHeader('Browse by Genre') +
      buildGenreShelf() +
      '<div id="home-more-placeholder"></div>' +
      '<div style="height:52px"></div>';

    scroll.addEventListener('click', onHomeClick);

    // ── Smooth drag-to-scroll with momentum ──────────────────────
    // Velocity is tracked as a rolling weighted average over the last
    // ~100 ms of pointer samples so a brief pause at lift-off doesn't
    // kill the flick, and a single noisy spike can't inflate it.
    const FRICTION   = 0.95;   // per-frame multiplier (higher = longer glide)
    const MIN_V      = 0.3;    // px/frame below which momentum stops
    const VEL_SAMPLE = 80;     // ms window used for velocity averaging
    let _drag = null;
    let _rafId = null;

    function cancelMomentum() {
      if (_rafId) { cancelAnimationFrame(_rafId); _rafId = null; }
    }

    function launchMomentum(strip, vPx) {
      cancelMomentum();
      let v = vPx;
      const step = () => {
        if (Math.abs(v) < MIN_V || strip.dataset.dragging === '1') return;
        strip.scrollLeft -= v;
        v *= FRICTION;
        _rafId = requestAnimationFrame(step);
      };
      _rafId = requestAnimationFrame(step);
    }

    // ── Mouse drag ────────────────────────────────────────────
    scroll.addEventListener('mousedown', e => {
      const strip = e.target.closest('.row-strip');
      if (!strip) return;
      e.preventDefault();
      cancelMomentum();
      strip.dataset.dragging = '1';
      strip.classList.add('is-dragging');
      _drag = {
        strip,
        startX:     e.clientX,
        scrollLeft: strip.scrollLeft,
        moved:      false,
        // Ring buffer of { x, t } for velocity averaging
        samples:    [{ x: e.clientX, t: performance.now() }],
      };
    }, { passive: false });

    window.addEventListener('mousemove', e => {
      if (!_drag) return;
      const dx = e.clientX - _drag.startX;
      if (Math.abs(dx) > 4) _drag.moved = true;

      // Keep a rolling window of recent samples
      const now = performance.now();
      _drag.samples.push({ x: e.clientX, t: now });
      // Prune samples older than VEL_SAMPLE ms
      while (_drag.samples.length > 1 && now - _drag.samples[0].t > VEL_SAMPLE) {
        _drag.samples.shift();
      }

      _drag.strip.scrollLeft = _drag.scrollLeft - dx;
    });

    window.addEventListener('mouseup', e => {
      if (!_drag) return;
      const { strip, moved, samples } = _drag;
      strip.dataset.dragging = '0';
      strip.classList.remove('is-dragging');
      _drag = null;

      if (moved) {
        // Compute velocity from the oldest surviving sample in the window
        const oldest = samples[0];
        const newest = samples[samples.length - 1];
        const dt = (newest.t - oldest.t) || 1;
        const vPxMs = (newest.x - oldest.x) / dt; // px/ms
        // Convert to px/frame at 60fps (~16.67 ms/frame)
        const vFrame = vPxMs * 16.67;

        if (Math.abs(vFrame) > MIN_V) launchMomentum(strip, vFrame);

        // Swallow the click that fires after mouseup so cards don't open
        window.addEventListener('click', ev => ev.stopImmediatePropagation(),
          { capture: true, once: true });
      }
    });

    // ── Touch drag (full velocity + momentum, not just scroll-lock) ──
    let _touch = null;

    scroll.addEventListener('touchstart', e => {
      const strip = e.target.closest('.row-strip');
      if (!strip) return;
      cancelMomentum();
      strip.dataset.dragging = '1';
      _touch = {
        strip,
        startX:     e.touches[0].clientX,
        startY:     e.touches[0].clientY,
        scrollLeft: strip.scrollLeft,
        axis:       null,   // 'h' | 'v' — locked after first movement
        samples:    [{ x: e.touches[0].clientX, t: performance.now() }],
      };
    }, { passive: true });

    scroll.addEventListener('touchmove', e => {
      if (!_touch) return;
      const tx = e.touches[0].clientX;
      const ty = e.touches[0].clientY;
      const dx = tx - _touch.startX;
      const dy = ty - _touch.startY;

      // Lock axis on first significant movement
      if (!_touch.axis) {
        if (Math.abs(dx) > 4 || Math.abs(dy) > 4) {
          _touch.axis = Math.abs(dx) >= Math.abs(dy) ? 'h' : 'v';
        }
        return;
      }
      if (_touch.axis !== 'h') return;

      e.stopPropagation();

      const now = performance.now();
      _touch.samples.push({ x: tx, t: now });
      while (_touch.samples.length > 1 && now - _touch.samples[0].t > VEL_SAMPLE) {
        _touch.samples.shift();
      }

      _touch.strip.scrollLeft = _touch.scrollLeft - dx;
    }, { passive: true });

    scroll.addEventListener('touchend', () => {
      if (!_touch) return;
      const { strip, axis, samples, startX } = _touch;
      strip.dataset.dragging = '0';
      _touch = null;
      if (axis !== 'h') return;

      const oldest = samples[0];
      const newest = samples[samples.length - 1];
      const dt = (newest.t - oldest.t) || 1;
      const vPxMs = (newest.x - oldest.x) / dt;
      const vFrame = vPxMs * 16.67;
      if (Math.abs(vFrame) > MIN_V) launchMomentum(strip, vFrame);
    }, { passive: true });

    document.getElementById('btn-hero-play').onclick =
      () => heroItem && openPlayer(heroItem.id, heroType, 1, 1, heroItem.title || heroItem.name || '', heroItem.poster_path);
    document.getElementById('btn-hero-info').onclick =
      () => heroItem && openDetail(heroItem.id, heroType);
    setFocus(document.getElementById('btn-hero-play'), false);

    // Wire hero carousel dots
    document.getElementById('hero-dots')?.addEventListener('click', e => {
      const dot = e.target.closest('.hero-dot');
      if (!dot) return;
      const idx = +dot.dataset.hi;
      _heroIdx = idx;
      updateHero(_heroItems[idx], idx);
      stopHeroCycle(); startHeroCycle();
    });
    startHeroCycle();

    // ── Phase 2: genres + country rows — deferred so Phase 1 paints first ──
    // setTimeout(0) yields the main thread; Phase 1 hero + 7 rows render
    // before any of the 22 additional TMDB network calls start.
    setTimeout(async () => {
      try {
        const [act, sci, hor, com, rom, ani, doc, thr, fam,
               usm, ukm, esm, inm, cnm, jpm, krm, dem, itm,
               ustv, krtv, jptv, intv] = await Promise.all([
          // Genres
          tmdb('/discover/movie', { with_genres: '28',    sort_by: 'popularity.desc', 'vote_count.gte': '200' }),
          tmdb('/discover/movie', { with_genres: '878',   sort_by: 'popularity.desc', 'vote_count.gte': '200' }),
          tmdb('/discover/movie', { with_genres: '27',    sort_by: 'popularity.desc', 'vote_count.gte': '200' }),
          tmdb('/discover/movie', { with_genres: '35',    sort_by: 'popularity.desc', 'vote_count.gte': '200' }),
          tmdb('/discover/movie', { with_genres: '10749', sort_by: 'popularity.desc', 'vote_count.gte': '200' }),
          tmdb('/discover/movie', { with_genres: '16',    sort_by: 'popularity.desc', 'vote_count.gte': '200' }),
          tmdb('/discover/movie', { with_genres: '99',    sort_by: 'popularity.desc', 'vote_count.gte': '100' }),
          tmdb('/discover/movie', { with_genres: '53',    sort_by: 'popularity.desc', 'vote_count.gte': '200' }),
          tmdb('/discover/movie', { with_genres: '10751', sort_by: 'popularity.desc', 'vote_count.gte': '200' }),
          // Country: Movies
          tmdb('/discover/movie', { with_origin_country: 'US',       sort_by: 'popularity.desc', 'vote_count.gte': '300' }),
          tmdb('/discover/movie', { with_origin_country: 'GB',       sort_by: 'popularity.desc', 'vote_count.gte': '100' }),
          tmdb('/discover/movie', { with_original_language: 'es',    sort_by: 'popularity.desc', 'vote_count.gte': '100' }),
          tmdb('/discover/movie', { with_origin_country: 'IN',       sort_by: 'popularity.desc', 'vote_count.gte': '100' }),
          tmdb('/discover/movie', { with_origin_country: 'CN|HK|TW', sort_by: 'popularity.desc', 'vote_count.gte': '100' }),
          tmdb('/discover/movie', { with_origin_country: 'JP',       sort_by: 'popularity.desc', 'vote_count.gte': '100' }),
          tmdb('/discover/movie', { with_origin_country: 'KR',       sort_by: 'popularity.desc', 'vote_count.gte': '100' }),
          tmdb('/discover/movie', { with_origin_country: 'DE',       sort_by: 'popularity.desc', 'vote_count.gte': '50'  }),
          tmdb('/discover/movie', { with_origin_country: 'IT',       sort_by: 'popularity.desc', 'vote_count.gte': '50'  }),
          // Country: TV
          tmdb('/discover/tv', { with_origin_country: 'US', sort_by: 'popularity.desc', 'vote_count.gte': '100' }),
          tmdb('/discover/tv', { with_origin_country: 'KR', sort_by: 'popularity.desc', 'vote_count.gte': '50'  }),
          tmdb('/discover/tv', { with_origin_country: 'JP', sort_by: 'popularity.desc', 'vote_count.gte': '50'  }),
          tmdb('/discover/tv', { with_origin_country: 'IN', sort_by: 'popularity.desc', 'vote_count.gte': '50'  }),
        ]);

        const moreHtml =
          buildRow('Action',             act.results,  'movie', { path: '/discover/movie', params: { with_genres: '28',    sort_by: 'popularity.desc', 'vote_count.gte': '200' } }) +
          buildRow('Sci-Fi',             sci.results,  'movie', { path: '/discover/movie', params: { with_genres: '878',   sort_by: 'popularity.desc', 'vote_count.gte': '200' } }) +
          buildRow('Horror',             hor.results,  'movie', { path: '/discover/movie', params: { with_genres: '27',    sort_by: 'popularity.desc', 'vote_count.gte': '200' } }) +
          buildRow('Comedy',             com.results,  'movie', { path: '/discover/movie', params: { with_genres: '35',    sort_by: 'popularity.desc', 'vote_count.gte': '200' } }) +
          buildRow('Romance',            rom.results,  'movie', { path: '/discover/movie', params: { with_genres: '10749', sort_by: 'popularity.desc', 'vote_count.gte': '200' } }) +
          buildRow('Animation',          ani.results,  'movie', { path: '/discover/movie', params: { with_genres: '16',    sort_by: 'popularity.desc', 'vote_count.gte': '200' } }) +
          buildRow('Documentary',        doc.results,  'movie', { path: '/discover/movie', params: { with_genres: '99',    sort_by: 'popularity.desc', 'vote_count.gte': '100' } }) +
          buildRow('Thriller',           thr.results,  'movie', { path: '/discover/movie', params: { with_genres: '53',    sort_by: 'popularity.desc', 'vote_count.gte': '200' } }) +
          buildRow('Family',             fam.results,  'movie', { path: '/discover/movie', params: { with_genres: '10751', sort_by: 'popularity.desc', 'vote_count.gte': '200' } }) +
          buildSectionHeader('Around the World') +
          buildRow('American',           usm.results,  'movie', { path: '/discover/movie', params: { with_origin_country: 'US',       sort_by: 'popularity.desc', 'vote_count.gte': '300' } }) +
          buildRow('British',            ukm.results,  'movie', { path: '/discover/movie', params: { with_origin_country: 'GB',       sort_by: 'popularity.desc', 'vote_count.gte': '100' } }) +
          buildRow('Latino & Spanish',   esm.results,  'movie', { path: '/discover/movie', params: { with_original_language: 'es',    sort_by: 'popularity.desc', 'vote_count.gte': '100' } }) +
          buildRow('Bollywood & Indian', inm.results,  'movie', { path: '/discover/movie', params: { with_origin_country: 'IN',       sort_by: 'popularity.desc', 'vote_count.gte': '100' } }) +
          buildRow('Chinese Cinema',     cnm.results,  'movie', { path: '/discover/movie', params: { with_origin_country: 'CN|HK|TW', sort_by: 'popularity.desc', 'vote_count.gte': '100' } }) +
          buildRow('Japanese Cinema',    jpm.results,  'movie', { path: '/discover/movie', params: { with_origin_country: 'JP',       sort_by: 'popularity.desc', 'vote_count.gte': '100' } }) +
          buildRow('Korean Cinema',      krm.results,  'movie', { path: '/discover/movie', params: { with_origin_country: 'KR',       sort_by: 'popularity.desc', 'vote_count.gte': '100' } }) +
          buildRow('German Cinema',      dem.results,  'movie', { path: '/discover/movie', params: { with_origin_country: 'DE',       sort_by: 'popularity.desc', 'vote_count.gte': '50'  } }) +
          buildRow('Italian Cinema',     itm.results,  'movie', { path: '/discover/movie', params: { with_origin_country: 'IT',       sort_by: 'popularity.desc', 'vote_count.gte': '50'  } }) +
          buildSectionHeader('International TV') +
          buildRow('American TV',        ustv.results, 'tv',    { path: '/discover/tv', params: { with_origin_country: 'US', sort_by: 'popularity.desc', 'vote_count.gte': '100' } }) +
          buildRow('K-Drama',            krtv.results, 'tv',    { path: '/discover/tv', params: { with_origin_country: 'KR', sort_by: 'popularity.desc', 'vote_count.gte': '50'  } }) +
          buildRow('Japanese TV',        jptv.results, 'tv',    { path: '/discover/tv', params: { with_origin_country: 'JP', sort_by: 'popularity.desc', 'vote_count.gte': '50'  } }) +
          buildRow('Indian TV',          intv.results, 'tv',    { path: '/discover/tv', params: { with_origin_country: 'IN', sort_by: 'popularity.desc', 'vote_count.gte': '50'  } });

        const placeholder = document.getElementById('home-more-placeholder');
        if (placeholder) {
          placeholder.insertAdjacentHTML('beforebegin', moreHtml);
          placeholder.remove();
        }
        // All rows (Phase 1 + Phase 2) are now in the DOM — set up infinite scroll once
        initRowInfiniteScroll(scroll);
      } catch (_) {
        // Genre/country rows failed — core 7-row content stays usable
        const ph = document.getElementById('home-more-placeholder');
        if (ph) ph.remove();
        // Still wire up infinite scroll for the Phase 1 rows
        initRowInfiniteScroll(scroll);
      }
    }, 0);

  } catch (err) {
    scroll.innerHTML = `<p class="err">⚠ Failed to load: ${h(err.message)}</p>`;
  }
}

function onHomeClick(e) {
  const t = e.target.closest('[data-action]');
  if (!t) return;
  const { action, id, type, season, episode, title, poster } = t.dataset;
  if (action === 'detail' || action === 'continue')
    openDetail(+id, type);
  else if (action === 'play')
    openPlayer(+id, type, 1, 1, title || '', poster || null);
  else if (action === 'genre')
    openGenreBrowser(+t.dataset.genreId, t.dataset.genreName, 'movie');
}

async function refreshContinueWatching() {
  const existing = document.getElementById('cw-row');
  const html = await buildContinueWatching();
  if (existing) {
    if (html) existing.outerHTML = html;
    else      existing.remove();
  } else {
    const first = document.querySelector('#home-scroll .cat-row');
    if (first && html) first.insertAdjacentHTML('beforebegin', html);
  }
}

/* ── HTML builders ── */
function buildHero(item) {
  if (!item) return '';
  const title = item.title || item.name || '';
  const year  = (item.release_date || item.first_air_date || '').slice(0, 4);
  const rat   = item.vote_average ? +item.vote_average.toFixed(1) : 0;
  const stars = rat ? buildStars(rat) : '';
  const bd    = backdropUrl(item.backdrop_path);
  const dotsHtml = _heroItems.length > 1
    ? _heroItems.map((_, i) =>
        `<div class="hero-dot focusable${i === 0 ? ' active' : ''}" tabindex="0" data-hi="${i}"></div>`
      ).join('')
    : '';
  return `<div id="hero">
    ${bd ? `<img id="hero-bg" src="${bd}" alt="${a(title)}">` : '<div id="hero-bg"></div>'}
    <div id="hero-grad"></div>
    <div id="hero-info">
      <div id="hero-eyebrow">Now Showing</div>
      <div id="hero-title">${h(title)}</div>
      <div id="hero-meta">
        ${stars ? `<span class="star-rating">${stars}</span>` : ''}
        ${year  ? `<span>${h(year)}</span>` : ''}
        ${rat   ? `<span>${h(rat.toFixed(1))} / 10</span>` : ''}
      </div>
      <div id="hero-desc">${h(item.overview || '')}</div>
      <div id="hero-btns">
        <button id="btn-hero-play" class="btn-white focusable" tabindex="0"
          data-action="play" data-id="${item.id}" data-type="movie"
          data-title="${a(title)}" data-poster="${a(item.poster_path||'')}">&#9654;  Play Now</button>
        <button id="btn-hero-info" class="btn-ghost focusable" tabindex="0"
          data-action="detail" data-id="${item.id}" data-type="movie">&#x24D8;  More Info</button>
      </div>
    </div>
    ${dotsHtml ? `<div id="hero-dots">${dotsHtml}</div>` : ''}
  </div>`;
}

async function buildContinueWatching() {
  const recs = await getRecents();
  if (!recs.length) return '';
  const cards = recs.map(w => makeCard(
    w.tmdbId, w.mediaType, w.posterPath, w.title,
    w.mediaType === 'tv' ? `S${w.season} E${w.episode}` : 'Resume',
    'continue', w.season || 1, w.episode || 1
  )).join('');
  return `<div class="cat-row" id="cw-row">
    <div class="cat-title">▶ Continue Watching</div>
    <div class="row-strip">${cards}</div>
  </div>`;
}

/* ── Infinite scroll for horizontal category rows ──────────
   Observes the .row-sentinel at the tail of each .row-strip.
   When it scrolls into view (horizontal), fetches the next TMDB
   page and appends cards before the sentinel. Stops when TMDB
   reports no more pages (page >= total_pages). */
function initRowInfiniteScroll(container) {
  const observer = new IntersectionObserver((entries) => {
    entries.forEach(async entry => {
      if (!entry.isIntersecting) return;
      const sentinel = entry.target;
      const strip    = sentinel.parentElement;
      if (!strip || strip.dataset.tmdbLoading === '1') return;

      const path      = strip.dataset.tmdbPath;
      const mediaType = strip.dataset.tmdbType;
      const params    = JSON.parse(strip.dataset.tmdbParams || '{}');
      const nextPage  = parseInt(strip.dataset.tmdbPage, 10) + 1;

      strip.dataset.tmdbLoading = '1';
      // Show a small spinner inside the sentinel while fetching
      sentinel.innerHTML = '<div class="row-load-spin"></div>';

      try {
        const data = await tmdb(path, { ...params, page: nextPage });
        const items = data.results || [];

        if (items.length && nextPage <= (data.total_pages || 1)) {
          const frag = document.createDocumentFragment();
          items.forEach(item => {
            const tmp = document.createElement('div');
            tmp.innerHTML = makeCard(
              item.id, mediaType, item.poster_path,
              item.title || item.name || '',
              item.vote_average ? '★ ' + item.vote_average.toFixed(1) : '',
              'detail'
            );
            frag.appendChild(tmp.firstElementChild);
          });
          strip.insertBefore(frag, sentinel);
          strip.dataset.tmdbPage = nextPage;
        }

        // If we've hit the last page, remove the sentinel entirely
        if (!items.length || nextPage >= (data.total_pages || 1)) {
          observer.unobserve(sentinel);
          sentinel.remove();
        } else {
          sentinel.innerHTML = ''; // clear spinner, ready for next trigger
        }
      } catch (_) {
        sentinel.innerHTML = ''; // fail silently, allow retry on next scroll
      }

      strip.dataset.tmdbLoading = '0';
    });
  }, {
    // Use the row-strip itself as the scroll root so intersection fires
    // based on horizontal scroll position, not the page viewport
    root: null,
    rootMargin: '0px 200px 0px 0px', // trigger 200px before the sentinel is fully visible
    threshold: 0,
  });

  container.querySelectorAll('.row-sentinel').forEach(s => observer.observe(s));
}

function buildGenreShelf() {
  const icons = { 28:'⚔️', 35:'😂', 18:'🎭', 27:'👻', 878:'🚀', 10749:'💕',
    53:'🔪', 16:'✏️', 99:'🎥', 10751:'👨‍👩‍👧', 14:'🧙', 36:'📜', 10402:'🎵', 9648:'🔍', 10752:'🎖️', 37:'🤠' };
  return `<div class="cat-row">
    <div class="cat-title">Genres</div>
    <div class="row-strip">
      ${GENRE_LIST_MOVIE.map(g => `
        <div class="genre-shelf-card focusable" tabindex="0"
             data-action="genre" data-genre-id="${g.id}" data-genre-name="${a(g.name)}">
          <span class="genre-shelf-icon">${icons[g.id] || '🎬'}</span>
          <span class="genre-shelf-name">${h(g.name)}</span>
        </div>`).join('')}
    </div>
  </div>`;
}

/* buildRow now accepts an optional { path, params } for infinite scroll.
   When provided it embeds the TMDB fetch info as data-* on the strip
   and appends a sentinel element that triggers the next-page load. */
function buildRow(title, items, type, fetchInfo) {
  if (!items?.length) return '';
  const cards = items.map(item =>
    makeCard(item.id, type, item.poster_path, item.title || item.name || '',
      item.vote_average ? '★ ' + item.vote_average.toFixed(1) : '', 'detail')
  ).join('');

  const stripAttrs = fetchInfo
    ? ` data-tmdb-path="${h(fetchInfo.path)}" data-tmdb-params='${JSON.stringify(fetchInfo.params || {})}' data-tmdb-type="${type}" data-tmdb-page="1" data-tmdb-loading="0"`
    : '';

  const sentinel = fetchInfo
    ? '<div class="row-sentinel" aria-hidden="true"></div>'
    : '';

  return `<div class="cat-row">
    <div class="cat-title">${h(title)}</div>
    <div class="row-strip"${stripAttrs}>${cards}${sentinel}</div>
  </div>`;
}

function buildSectionHeader(label) {
  return `<div class="section-divider"><span class="section-divider-label">${h(label)}</span></div>`;
}

function makeCard(id, type, posterPath, title, sub, action, season = 1, episode = 1) {
  return `<div class="card focusable" tabindex="0"
    data-action="${action}" data-id="${id}" data-type="${type}"
    data-season="${season}" data-episode="${episode}"
    data-title="${a(title)}" data-poster="${a(posterPath || '')}">
    <img src="${posterUrl(posterPath)}" alt="${a(title)}" loading="lazy">
    <div class="card-label">
      <div class="card-name">${h(title)}</div>
      ${sub ? `<div class="card-sub">${h(sub)}</div>` : ''}
    </div>
  </div>`;
}

/* ═══════════════════════════════════════════════════════════════════
   DETAIL SCREEN
═══════════════════════════════════════════════════════════════════ */
let _det = {};

async function openDetail(id, mediaType) {
  navigateTo('detail', () => {
    document.getElementById('view-detail').innerHTML = spinner();
  });

  try {
    const data = mediaType === 'movie'
      ? await tmdb(`/movie/${id}`, { append_to_response: 'credits,videos,recommendations,reviews,watch/providers' })
      : await tmdb(`/tv/${id}`,    { append_to_response: 'credits,videos,recommendations,reviews,watch/providers' });
    _det = { id, mediaType, data, season: 1 };
    renderDetail();
  } catch (err) {
    document.getElementById('view-detail').innerHTML = `<p class="err">⚠ ${h(err.message)}</p>`;
  }
}

async function renderDetail(newSeason) {
  const { id, mediaType, data } = _det;
  if (newSeason != null) _det.season = newSeason;
  const curSeason = _det.season || 1;

  const title    = data.title || data.name || '';
  const year     = (data.release_date || data.first_air_date || '').slice(0, 4);
  const rat      = data.vote_average ? +data.vote_average.toFixed(1) : 0;
  const stars    = rat ? buildStars(rat) : '';
  const runtime  = data.runtime
    ? data.runtime + ' min'
    : (data.episode_run_time?.[0] ? data.episode_run_time[0] + ' min/ep' : '');
  const tagline  = data.tagline || '';
  const genres   = (data.genres || []).slice(0, 5).map(g => g.name);
  const prog     = await getProgress(mediaType, id);
  const bd       = bigBdUrl(data.backdrop_path);

  /* ── Trailer ─────────────────────────────────── */
  const vids = data.videos?.results || [];
  const trailerKey = (vids.find(v => v.site === 'YouTube' && v.type === 'Trailer' && v.official !== false)
    || vids.find(v => v.site === 'YouTube' && v.type === 'Trailer')
    || vids.find(v => v.site === 'YouTube'))?.key || null;

  /* ── Watch providers (US → any region) ─────── */
  const provRegions = data['watch/providers']?.results || {};
  const provData    = provRegions.US || Object.values(provRegions)[0] || null;
  const flatrate    = (provData?.flatrate || []).slice(0, 6);

  /* ── Cast ───────────────────────────────────── */
  const cast = (data.credits?.cast || []).slice(0, 14);

  /* ── Crew highlights ────────────────────────── */
  const crew = data.credits?.crew || [];
  const director = crew.find(c => c.job === 'Director')?.name || '';
  const creator  = (data.created_by || [])[0]?.name || '';

  /* ── Collection ─────────────────────────────── */
  const collection = mediaType === 'movie' ? data.belongs_to_collection : null;

  /* ── Reviews ────────────────────────────────── */
  const reviews = (data.reviews?.results || []).slice(0, 3);

  /* ── Recommendations ────────────────────────── */
  const recs = (data.recommendations?.results || [])
    .filter(r => r.poster_path).slice(0, 24);

  /* ── TV episodes ────────────────────────────── */
  let epHTML = '';
  if (mediaType === 'tv') {
    const nSeasons = data.number_of_seasons || 1;
    const sBtns = Array.from({ length: nSeasons }, (_, i) => i + 1)
      .map(s => `<button class="s-btn focusable${s === curSeason ? ' active' : ''}" tabindex="0" data-s="${s}">S${s}</button>`)
      .join('');
    let eBtns = '<span style="color:#999;font-size:14px">Loading episodes…</span>';
    try {
      const sd = await tmdb(`/tv/${id}/season/${curSeason}`);
      eBtns = (sd.episodes || []).map(ep =>
        `<button class="ep-btn focusable" tabindex="0" data-ep="${ep.episode_number}">E${ep.episode_number}${ep.name ? ' · ' + h(ep.name.slice(0, 32)) : ''}</button>`
      ).join('');
    } catch (_) {}
    epHTML = `<div id="ep-section">
      <div class="ep-hdr">Episodes</div>
      <div id="season-row">${sBtns}</div>
      <div id="ep-grid">${eBtns}</div>
    </div>`;
  }

  /* ── Resume button ──────────────────────────── */
  const resumeBtn = prog ? (() => {
    const ts = prog.watchTimestamp || 0;
    const tsFmt = ts > 0 ? ` · ${fmtTs(ts)}` : '';
    const label = mediaType === 'tv'
      ? `↩ Resume S${prog.season} E${prog.episode}${tsFmt}`
      : `↩ Resume${tsFmt}`;
    return `<button id="btn-resume" class="btn-resume focusable" tabindex="0"
        data-ts="${ts}" data-season="${prog.season||1}" data-episode="${prog.episode||1}">${label}</button>
      <button id="btn-start-over" class="btn-back focusable" tabindex="0">↺ Start Over</button>`;
  })() : '';

  const isFav = await isFavorite(mediaType, id);

  /* ── Build HTML blocks ──────────────────────── */
  const genreChips = genres.length
    ? `<div id="detail-genres">${genres.map(g => `<span class="genre-chip">${h(g)}</span>`).join('')}</div>`
    : '';

  const providersHTML = flatrate.length ? `
    <div id="detail-providers">
      <span class="providers-label">Stream on</span>
      ${flatrate.map(p => `<img class="provider-logo" src="${IMG}/w45${p.logo_path}"
         alt="${a(p.provider_name)}" title="${a(p.provider_name)}" loading="lazy">`).join('')}
    </div>` : '';

  const trailerBtn = trailerKey
    ? `<button id="btn-trailer" class="btn-trailer focusable" tabindex="0">▶ Trailer</button>`
    : '';

  const crewLine = (director || creator) ? `
    <div class="detail-crew-line">
      ${director ? `<span class="crew-item"><span class="crew-role">Director</span> ${h(director)}</span>` : ''}
      ${creator  ? `<span class="crew-item"><span class="crew-role">Creator</span> ${h(creator)}</span>`  : ''}
    </div>` : '';

  const castHTML = cast.length ? `
    <div class="detail-section" id="detail-cast">
      <div class="detail-section-title">Cast</div>
      <div class="cast-strip">
        ${cast.map(c => `<div class="cast-card">
          <div class="cast-avatar-wrap">
            <img class="cast-avatar" loading="lazy"
              src="${c.profile_path ? IMG+'/w185'+c.profile_path : 'https://placehold.co/185x185/141426/555?text=?'}"
              alt="${a(c.name)}">
          </div>
          <div class="cast-name">${h(c.name)}</div>
          <div class="cast-char">${h((c.character||'').slice(0,26))}</div>
        </div>`).join('')}
      </div>
    </div>` : '';

  const collectionHTML = collection ? `
    <div class="detail-section" id="detail-collection">
      <div class="detail-section-title">Part of a Collection</div>
      <div class="collection-banner focusable" tabindex="0"
           data-coll-id="${collection.id}" data-coll-name="${a(collection.name)}">
        ${collection.backdrop_path
          ? `<img class="collection-bg" src="${IMG}/w780${collection.backdrop_path}" alt="" loading="lazy">`
          : ''}
        <div class="collection-info">
          <div class="collection-eyebrow">Complete Franchise</div>
          <div class="collection-name">${h(collection.name)}</div>
          <div class="collection-cta">Browse All Films →</div>
        </div>
      </div>
    </div>` : '';

  const reviewsHTML = reviews.length ? `
    <div class="detail-section" id="detail-reviews">
      <div class="detail-section-title">Audience Reviews</div>
      <div class="reviews-list">
        ${reviews.map(r => `<div class="review-card">
          <div class="review-header">
            <div class="review-author">${h(r.author)}</div>
            ${r.author_details?.rating
              ? `<div class="review-rating">★ ${h(String(r.author_details.rating))}</div>`
              : ''}
          </div>
          <div class="review-text">${h((r.content||'').slice(0,360))}${(r.content||'').length>360?'…':''}</div>
        </div>`).join('')}
      </div>
    </div>` : '';

  const recsHTML = recs.length ? `
    <div class="detail-section" id="detail-more">
      <div class="detail-section-title">More Like This</div>
      <div class="row-strip detail-more-strip">
        ${recs.map(r => makeCard(r.id, mediaType, r.poster_path,
            r.title || r.name || '',
            r.vote_average ? '★ ' + r.vote_average.toFixed(1) : '',
            'detail')).join('')}
      </div>
    </div>` : '';

  /* ── Meta line ──────────────────────────────── */
  const metaItems = [
    year     ? `<span>${h(year)}</span>` : '',
    stars    ? `<span class="star-rating">${stars}</span><span>${rat.toFixed(1)} / 10</span>` : '',
    runtime  ? `<span>${h(runtime)}</span>` : '',
    mediaType === 'tv' ? `<span>TV Series</span>` : `<span>Movie</span>`,
    data.status && data.status !== 'Released' && data.status !== 'Ended'
      ? `<span class="status-badge">${h(data.status)}</span>` : '',
  ].filter(Boolean).join('');

  /* ── Render ─────────────────────────────────── */
  document.getElementById('view-detail').innerHTML = `
    ${bd ? `<img id="detail-bg" src="${bd}" alt="">` : ''}
    <div id="detail-grad"></div>
    <div id="detail-scroll">
      <div id="detail-body">
        <img id="detail-poster" src="${posterUrl(data.poster_path)}" alt="${a(title)}">
        <div id="detail-info">
          ${tagline ? `<div id="detail-tagline">"${h(tagline)}"</div>` : ''}
          <div id="detail-title">${h(title)}</div>
          <div id="detail-meta">${metaItems}</div>
          ${genreChips}
          <div id="detail-overview">${h(data.overview || '')}</div>
          ${crewLine}
          ${providersHTML}
          <div id="detail-btns">
            <button id="btn-play"  class="btn-play  focusable" tabindex="0">▶  Play</button>
            ${trailerBtn}
            ${resumeBtn}
            <button id="btn-fav" class="btn-fav focusable${isFav ? ' fav-active' : ''}" tabindex="0"
              title="${isFav ? 'Remove from favorites' : 'Add to favorites'}">
              ${isFav ? '❤️' : '🤍'} ${isFav ? 'Favorited' : 'Favorite'}
            </button>
            <button id="btn-dback" class="btn-back  focusable" tabindex="0">← Back</button>
          </div>
          ${epHTML}
        </div>
      </div>
      ${castHTML}
      ${collectionHTML}
      ${reviewsHTML}
      ${recsHTML}
      <div style="height:72px"></div>
    </div>`;

  /* ── Wire events ────────────────────────────── */
  const view = document.getElementById('view-detail');

  view.querySelector('#btn-play').onclick =
    () => openPlayer(id, mediaType, curSeason, 1, title, data.poster_path);

  if (trailerKey) {
    view.querySelector('#btn-trailer').onclick =
      () => window.open(`https://www.youtube.com/watch?v=${trailerKey}`, '_blank');
  }

  const resumeEl = view.querySelector('#btn-resume');
  if (resumeEl) {
    resumeEl.addEventListener('click', () => {
      const ts = +(resumeEl.dataset.ts      || 0);
      const s  = +(resumeEl.dataset.season  || prog?.season  || 1);
      const ep = +(resumeEl.dataset.episode || prog?.episode || 1);
      openPlayer(id, mediaType, s, ep, title, data.poster_path, ts);
    });
  }
  view.querySelector('#btn-start-over')?.addEventListener('click', () => {
    openPlayer(id, mediaType, curSeason, 1, title, data.poster_path, 0);
  });
  view.querySelector('#btn-fav').addEventListener('click', async () => {
    const favBtn = view.querySelector('#btn-fav');
    const nowFav = await toggleFavorite({
      tmdbId: id, mediaType, title, posterPath: data.poster_path || null
    });
    favBtn.classList.toggle('fav-active', nowFav);
    favBtn.innerHTML = nowFav ? '❤️ Favorited' : '🤍 Favorite';
    favBtn.title = nowFav ? 'Remove from favorites' : 'Add to favorites';
    showToast(nowFav ? '❤️ Added to favorites!' : '💔 Removed from favorites.', nowFav ? 'ok' : 'neutral');
  });
  view.querySelector('#btn-dback').onclick = goBack;

  view.querySelectorAll('.s-btn').forEach(b =>
    b.addEventListener('click', () => renderDetail(+b.dataset.s))
  );
  view.querySelectorAll('.ep-btn').forEach(b =>
    b.addEventListener('click', () => openPlayer(id, mediaType, curSeason, +b.dataset.ep, title, data.poster_path))
  );

  /* Collection banner */
  view.querySelector('.collection-banner')?.addEventListener('click', e => {
    const el = e.currentTarget;
    openCollection(+el.dataset.collId, el.dataset.collName);
  });

  /* More Like This cards */
  view.querySelector('.detail-more-strip')?.addEventListener('click', e => {
    const card = e.target.closest('.card[data-id]');
    if (card) openDetail(+card.dataset.id, mediaType);
  });

  /* Drag-scroll for cast strip */
  _bindStripDrag(view.querySelector('.cast-strip'));
  _bindStripDrag(view.querySelector('.detail-more-strip'));

  setFocus(view.querySelector('#btn-play'), false);
}

/* ── Simple drag-to-scroll helper (used in detail sections) ── */
function _bindStripDrag(el) {
  if (!el) return;
  let _start = null;
  el.addEventListener('mousedown', e => {
    _start = { x: e.clientX, sl: el.scrollLeft };
    el.style.cursor = 'grabbing';
    e.preventDefault();
  }, { passive: false });
  window.addEventListener('mousemove', e => {
    if (!_start) return;
    el.scrollLeft = _start.sl - (e.clientX - _start.x);
  });
  window.addEventListener('mouseup', () => { _start = null; el.style.cursor = ''; });
}

/* ═══════════════════════════════════════════════════════════════════
   COLLECTION VIEW
═══════════════════════════════════════════════════════════════════ */
async function openCollection(id, name) {
  navigateTo('collection', () => {
    document.getElementById('view-collection').innerHTML = spinner();
  });
  try {
    const data = await tmdb(`/collection/${id}`);
    renderCollection(data);
  } catch (err) {
    document.getElementById('view-collection').innerHTML =
      `<p class="err">⚠ ${h(err.message)}</p>`;
  }
}

function renderCollection(data) {
  const parts = (data.parts || [])
    .filter(p => p.poster_path)
    .sort((a, b) => (a.release_date || '').localeCompare(b.release_date || ''));

  const bd = bigBdUrl(data.backdrop_path);

  document.getElementById('view-collection').innerHTML = `
    ${bd ? `<img id="coll-bg" src="${bd}" alt="">` : ''}
    <div id="coll-grad"></div>
    <div id="coll-scroll">
      <div id="coll-header">
        <button id="btn-coll-back" class="p-btn focusable" tabindex="0">← Back</button>
        <div id="coll-title">${h(data.name)}</div>
      </div>
      ${data.overview
        ? `<div id="coll-overview">${h(data.overview)}</div>`
        : ''}
      <div class="coll-count">${parts.length} Film${parts.length !== 1 ? 's' : ''}</div>
      <div id="coll-grid">
        ${parts.map(p => makeCard(p.id, 'movie', p.poster_path,
            p.title || '',
            (p.release_date || '').slice(0, 4),
            'detail')).join('')}
      </div>
      <div style="height:60px"></div>
    </div>`;

  const view = document.getElementById('view-collection');
  view.querySelector('#btn-coll-back').onclick = goBack;
  view.querySelector('#coll-grid').addEventListener('click', e => {
    const card = e.target.closest('.card[data-id]');
    if (card) openDetail(+card.dataset.id, 'movie');
  });
  requestAnimationFrame(() => setFocus(view.querySelector('.focusable'), false));
}

/* ═══════════════════════════════════════════════════════════════════
   GENRE BROWSER
═══════════════════════════════════════════════════════════════════ */
const GENRE_LIST_MOVIE = [
  { id: 28,    name: 'Action' },
  { id: 35,    name: 'Comedy' },
  { id: 18,    name: 'Drama' },
  { id: 27,    name: 'Horror' },
  { id: 878,   name: 'Sci-Fi' },
  { id: 10749, name: 'Romance' },
  { id: 53,    name: 'Thriller' },
  { id: 16,    name: 'Animation' },
  { id: 99,    name: 'Documentary' },
  { id: 10751, name: 'Family' },
  { id: 14,    name: 'Fantasy' },
  { id: 36,    name: 'History' },
  { id: 10402, name: 'Music' },
  { id: 9648,  name: 'Mystery' },
  { id: 10752, name: 'War' },
  { id: 37,    name: 'Western' },
];

async function openGenreBrowser(genreId, genreName, mediaType = 'movie') {
  navigateTo('genre', () => {
    document.getElementById('view-genre').innerHTML = spinner();
  });
  try {
    const path = mediaType === 'tv' ? '/discover/tv' : '/discover/movie';
    const data = await tmdb(path, {
      with_genres: String(genreId),
      sort_by: 'popularity.desc',
      'vote_count.gte': '100',
    });
    renderGenreBrowser(data, genreId, genreName, mediaType, path);
  } catch (err) {
    document.getElementById('view-genre').innerHTML =
      `<p class="err">⚠ ${h(err.message)}</p>`;
  }
}

function renderGenreBrowser(data, genreId, genreName, mediaType, path) {
  const items = (data.results || []).filter(r => r.poster_path);

  const stripAttrs = ` data-tmdb-path="${h(path)}"
    data-tmdb-params='${JSON.stringify({ with_genres: String(genreId), sort_by: 'popularity.desc', 'vote_count.gte': '100' })}'
    data-tmdb-type="${mediaType}" data-tmdb-page="1" data-tmdb-loading="0"`;

  document.getElementById('view-genre').innerHTML = `
    <div id="genre-header">
      <button id="btn-genre-back" class="p-btn focusable" tabindex="0">← Back</button>
      <div id="genre-title">${h(genreName)}</div>
      <div id="genre-type-toggle">
        <button class="genre-type-btn focusable${mediaType==='movie'?' active':''}" tabindex="0" data-mt="movie">Movies</button>
        <button class="genre-type-btn focusable${mediaType==='tv'?' active':''}"    tabindex="0" data-mt="tv">TV Shows</button>
      </div>
    </div>
    <div id="genre-scroll">
      <div id="genre-grid"${stripAttrs}>
        ${items.map(item => makeCard(item.id, mediaType, item.poster_path,
            item.title || item.name || '',
            item.vote_average ? '★ ' + item.vote_average.toFixed(1) : '',
            'detail')).join('')}
        <div class="genre-sentinel" style="width:100%;height:48px;flex-basis:100%" aria-hidden="true"></div>
      </div>
    </div>`;

  const view = document.getElementById('view-genre');
  view.querySelector('#btn-genre-back').onclick = goBack;

  view.querySelectorAll('.genre-type-btn').forEach(btn => {
    btn.addEventListener('click', () => openGenreBrowser(genreId, genreName, btn.dataset.mt));
  });

  view.querySelector('#genre-grid').addEventListener('click', e => {
    const card = e.target.closest('.card[data-id]');
    if (card) openDetail(+card.dataset.id, card.dataset.type || mediaType);
  });

  // Vertical infinite scroll for genre grid
  _initGenreInfiniteScroll(document.getElementById('genre-scroll'));
  requestAnimationFrame(() => setFocus(view.querySelector('.focusable'), false));
}

function _initGenreInfiniteScroll(scrollEl) {
  const observer = new IntersectionObserver(async entries => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const sentinel = entry.target;
      const grid = sentinel.parentElement;
      if (!grid || grid.dataset.tmdbLoading === '1') continue;
      const path   = grid.dataset.tmdbPath;
      const mt     = grid.dataset.tmdbType;
      const params = JSON.parse(grid.dataset.tmdbParams || '{}');
      const nextPage = parseInt(grid.dataset.tmdbPage, 10) + 1;
      grid.dataset.tmdbLoading = '1';
      sentinel.innerHTML = '<div class="row-load-spin" style="margin:12px auto;display:block"></div>';
      try {
        const data = await tmdb(path, { ...params, page: nextPage });
        const items = (data.results || []).filter(r => r.poster_path);
        if (items.length) {
          const frag = document.createDocumentFragment();
          items.forEach(item => {
            const tmp = document.createElement('div');
            tmp.innerHTML = makeCard(item.id, mt, item.poster_path,
              item.title || item.name || '',
              item.vote_average ? '★ ' + item.vote_average.toFixed(1) : '', 'detail');
            frag.appendChild(tmp.firstElementChild);
          });
          grid.insertBefore(frag, sentinel);
          grid.dataset.tmdbPage = nextPage;
        }
        if (!items.length || nextPage >= (data.total_pages || 1)) {
          observer.unobserve(sentinel); sentinel.remove();
        } else { sentinel.style.height = '48px'; }
      } catch (_) { sentinel.innerHTML = ''; }
      grid.dataset.tmdbLoading = '0';
    }
  }, { root: null, rootMargin: '0px 0px 400px 0px', threshold: 0 });
  scrollEl.querySelectorAll('.genre-sentinel').forEach(s => observer.observe(s));
}

/* ═══════════════════════════════════════════════════════════════════
   PLAYER SCREEN
═══════════════════════════════════════════════════════════════════ */
let _pl = {};
let _lastSave = 0;
let _streamTimer   = null;
let _streamStarted = false;

/* ── Wall-clock watch tracker ───────────────────────────────────────
   Since third-party iframes rarely send postMessage in our exact format,
   we estimate the current position using elapsed wall-clock time.
   When the iframe DOES send an accurate currentTime we anchor to it.
   ─────────────────────────────────────────────────────────────────── */
let _watchTimer   = null;
let _watchBaseTs  = 0;     // last known accurate position (seconds)
let _watchStartMs = 0;     // Date.now() when _watchBaseTs was set

function _watchCurrent() {
  if (!_watchStartMs) return _watchBaseTs;
  return _watchBaseTs + Math.floor((Date.now() - _watchStartMs) / 1000);
}

function _startWatchClock(baseTs) {
  _stopWatchClock();
  _watchBaseTs  = baseTs || 0;
  _watchStartMs = Date.now();
  // Save an estimate every 20 s of wall-clock time
  _watchTimer = setInterval(() => {
    if (active !== 'player' || !_pl.id) return;
    const est = _watchCurrent();
    if (est < 5) return;
    _pl.resumeTs = est;
    _lastSave = Date.now();
    saveProgress({
      tmdbId:         _pl.id,
      mediaType:      _pl.mediaType,
      title:          _pl.title,
      posterPath:     _pl.posterPath,
      season:         _pl.season,
      episode:        _pl.episode,
      watchTimestamp: est,
      updatedAt:      _lastSave,
    });
  }, 20_000);
}

function _stopWatchClock() {
  if (_watchTimer) { clearInterval(_watchTimer); _watchTimer = null; }
}

function startStreamTimer() {
  clearStreamTimer();
  _streamStarted = false;
  _streamTimer = setTimeout(() => {
    if (active !== 'player') return;
    const wrap = document.getElementById('frame-wrap');
    if (!wrap) return;
    const { src } = _pl;
    const srcs = _pl.mediaType === 'movie'
      ? SRCS.movie(_pl.id, _pl.resumeTs)
      : SRCS.tv(_pl.id, _pl.season, _pl.episode, _pl.resumeTs);
    const isLast = src >= srcs.length - 1;
    const ov = document.createElement('div');
    ov.id = 'no-stream-overlay';
    ov.innerHTML = `
      <div style="font-size:52px">😔</div>
      <div style="font-size:22px;font-weight:800;margin-bottom:8px">No stream found</div>
      <div style="font-size:15px;color:#888;max-width:400px;text-align:center;line-height:1.7;margin-bottom:24px">
        ${h(SRC_NAMES[src])} couldn't find a stream for this title.<br>
        It may not be released yet, or temporarily unavailable.
      </div>
      <div style="display:flex;gap:12px;flex-wrap:wrap;justify-content:center">
        ${!isLast ? `<button id="btn-ns-next" class="focusable"
          style="background:#e50914;color:#fff;padding:12px 26px;border-radius:6px;
                 font-size:16px;font-weight:800;border:3px solid transparent">
          📡 Try Next Source
        </button>` : ''}
        <button id="btn-ns-back" class="focusable"
          style="background:rgba(255,255,255,.12);color:#fff;padding:12px 26px;
                 border-radius:6px;font-size:16px;font-weight:700;border:3px solid transparent">
          ← Go Back
        </button>
      </div>`;
    wrap.appendChild(ov);
    document.getElementById('btn-ns-next')?.addEventListener('click', () => switchSrc(1));
    document.getElementById('btn-ns-back')?.addEventListener('click', goBack);
    const firstBtn = ov.querySelector('.focusable');
    if (firstBtn) setFocus(firstBtn, false);
  }, 30000);
}

function clearStreamTimer() {
  if (_streamTimer) { clearTimeout(_streamTimer); _streamTimer = null; }
}

const SRCS = {
  movie: (id, ts) => {
    const t = (ts > 5) ? Math.floor(ts) : 0;
    return [
      // 0: VidLink (primary)
      `https://vidlink.pro/movie/${id}?autoplay=true&primaryColor=e50914${t?'&startAt='+t:''}`,
      // 1: VidKing
      `https://www.vidking.net/embed/movie/${id}?color=e50914&autoPlay=true${t?'&t='+t:''}`,
      // 2: VidEasy
      `https://player.videasy.net/movie/${id}?autoplay=true&color=e50914${t?'&episode='+t:''}`,
      // 3: VidSrc (English)
      `https://vidsrc.me/embed/movie?tmdb=${id}&autoplay=1${t?'&t='+t:''}`,
      // 4: Vidfast
      `https://vidfast.pro/movie/${id}?autoPlay=true${t?'&startAt='+t:''}`,
      // 5: 2Embed
      `https://www.2embed.stream/embed/movie/${id}`,
      // 6: SuperEmbed
      `https://multiembed.mov/?video_id=${id}&tmdb=1&autoplay=true`,
      // 7: Vidora
      `https://vidora.su/embed/movie/${id}?autoplay=true`,
      // 8: Mapple
      `https://mapple.tv/embed/movie/${id}?autoplay=true`,
      // Country servers (kept for regional content)
      `https://vidsrc.me/embed/movie?tmdb=${id}&ds_lang=hi&autoplay=1`,
      `https://multiembed.mov/?video_id=${id}&tmdb=1&lang=fr&autoplay=true`,
      `https://vidsrc.me/embed/movie?tmdb=${id}&ds_lang=ja&autoplay=1`,
      `https://vidsrc.me/embed/movie?tmdb=${id}&ds_lang=zh&autoplay=1`,
    ];
  },
  tv: (id, s, e, ts) => {
    const t = (ts > 5) ? Math.floor(ts) : 0;
    return [
      // 0: VidLink (primary)
      `https://vidlink.pro/tv/${id}/${s}/${e}?autoplay=true&primaryColor=e50914${t?'&startAt='+t:''}`,
      // 1: VidKing
      `https://www.vidking.net/embed/tv/${id}/${s}/${e}?color=e50914&autoPlay=true&nextEpisode=true&episodeSelector=true${t?'&t='+t:''}`,
      // 2: VidEasy
      `https://player.videasy.net/tv/${id}/${s}/${e}?autoplay=true&color=e50914&nextEpisode=true`,
      // 3: VidSrc (English)
      `https://vidsrc.me/embed/tv?tmdb=${id}&season=${s}&episode=${e}&autoplay=1${t?'&t='+t:''}`,
      // 4: Vidfast
      `https://vidfast.pro/tv/${id}/${s}/${e}?autoPlay=true`,
      // 5: 2Embed
      `https://www.2embed.stream/embed/tv/${id}/${s}/${e}`,
      // 6: SuperEmbed
      `https://multiembed.mov/?video_id=${id}&tmdb=1&s=${s}&e=${e}&autoplay=true`,
      // 7: Vidora
      `https://vidora.su/embed/tv/${id}/${s}/${e}?autoplay=true`,
      // 8: Mapple
      `https://mapple.tv/embed/tv/${id}/${s}/${e}?autoplay=true`,
      // Country servers (kept for regional content)
      `https://vidsrc.me/embed/tv?tmdb=${id}&season=${s}&episode=${e}&ds_lang=hi&autoplay=1`,
      `https://multiembed.mov/?video_id=${id}&tmdb=1&s=${s}&e=${e}&lang=fr&autoplay=true`,
      `https://vidsrc.me/embed/tv?tmdb=${id}&season=${s}&episode=${e}&ds_lang=ja&autoplay=1`,
      `https://vidsrc.me/embed/tv?tmdb=${id}&season=${s}&episode=${e}&ds_lang=zh&autoplay=1`,
    ];
  },
};
const SRC_NAMES = [
  'VidLink', 'VidKing', 'VidEasy', 'VidSrc',
  'Vidfast', '2Embed', 'SuperEmbed', 'Vidora', 'Mapple',
  '🇮🇳 Indian', '🇫🇷 French', '🇯🇵 Japanese', '🇨🇳 Chinese',
];

/* ═══════════════════════════════════════════════════════════════════
   PLAYER SCREEN
═══════════════════════════════════════════════════════════════════ */

async function openPlayer(id, mediaType, season, episode, title, posterPath, forceTs) {
  season  = season  || 1;
  episode = episode || 1;
  title   = title   || '';

  if (_session) {
    const cloud = await _cloudGetProgress(mediaType, id);
    if (cloud && cloud.watchTimestamp > 5) {
      const relevant = mediaType === 'movie' ||
        (cloud.season === season && cloud.episode === episode);
      if (relevant) {
        _localSaveProgress({
          tmdbId: id, mediaType, title,
          posterPath: posterPath || null,
          season, episode,
          watchTimestamp: cloud.watchTimestamp,
          updatedAt: Date.now(),
        });
      }
    }
  }

  let resumeTs = 0;
  if (forceTs != null) {
    resumeTs = forceTs;
  } else {
    const local = _localGetProgress(mediaType, id);
    resumeTs = (local && (mediaType === 'movie' ||
      (local.season === season && local.episode === episode)))
      ? (local.watchTimestamp || 0) : 0;
  }

  const defaultSrc = _profile?.preferred_source ?? 0;
  _pl = { id, mediaType, season, episode, title, posterPath: posterPath || null, src: defaultSrc, resumeTs };
  _lastSave = Date.now();

  await saveProgress({
    tmdbId: id, mediaType, title,
    posterPath: posterPath || null,
    season, episode, updatedAt: Date.now(),
    ...(resumeTs > 0 ? { watchTimestamp: resumeTs } : {}),
  });

  navigateTo('player', renderPlayer);
  window.addEventListener('message', onPlayerMsg);
}

function renderPlayer() {
  const { id, mediaType, season, episode, title, src, resumeTs } = _pl;
  const srcs    = mediaType === 'movie' ? SRCS.movie(id, resumeTs) : SRCS.tv(id, season, episode, resumeTs);
  const url     = srcs[src];
  const srcName = SRC_NAMES[src] || `Source ${src + 1}`;
  const display = mediaType === 'tv' ? `${title}  ·  S${season} E${episode}` : title;

  document.getElementById('view-player').innerHTML = `
    <div id="player-bar">
      <button id="btn-p-exit" class="p-btn focusable" tabindex="0">← Exit</button>
      <span id="player-title">${h(display)}</span>
      <div style="display:flex;align-items:center;gap:8px;flex-shrink:0">
        <button id="btn-src-prev" class="p-btn focusable" tabindex="0">◀</button>
        <span id="src-label">${h(srcName)} ${src + 1}/${srcs.length}</span>
        <button id="btn-src-next" class="p-btn focusable" tabindex="0">▶</button>
      </div>
    </div>
    <div id="frame-wrap">
      <iframe id="player-frame"
        src="${url}"
        allowfullscreen
        allow="autoplay; fullscreen; encrypted-media; picture-in-picture; gyroscope; accelerometer"
        referrerpolicy="no-referrer"
      ></iframe>
    </div>`;

  document.getElementById('btn-p-exit').onclick   = goBack;
  document.getElementById('btn-src-prev').onclick = () => switchSrc(-1);
  document.getElementById('btn-src-next').onclick = () => switchSrc(+1);

  if (_pl.resumeTs > 5) {
    const rt = document.createElement('div');
    rt.id = 'resume-toast';
    rt.textContent = `↩ Resuming from ${fmtTs(_pl.resumeTs)}`;
    document.getElementById('frame-wrap').appendChild(rt);
    requestAnimationFrame(() => rt.classList.add('visible'));
    setTimeout(() => rt.classList.remove('visible'), 4000);
    setTimeout(() => rt.remove(), 4600);
  }

  startStreamTimer();
  _startWatchClock(_pl.resumeTs);   // wall-clock position tracker
  setFocus(document.getElementById('btn-p-exit'), false);

  // Fallback seek via postMessage — fires after the iframe player has had time
  // to initialise. Some embeds (VidLink, VidKing, etc.) accept the startAt URL
  // param but don't actually seek until the player is ready; this covers that gap.
  if (_pl.resumeTs > 5) {
    const frame   = document.getElementById('player-frame');
    const _doSeek = () => {
      const ts = _pl.resumeTs;
      if (!frame || !frame.contentWindow || ts <= 5) return;
      // Try every known postMessage seek format used by the embedded players
      const msgs = [
        { type: 'seek',          time: ts },
        { event: 'seek',         time: ts },
        { type: 'setCurrentTime',time: ts },
        { type: 'vidlink',       data: { type: 'seek', time: ts } },
        JSON.stringify({ event: 'seek', time: ts }),
        JSON.stringify({ type:  'seek', time: ts }),
      ];
      for (const m of msgs) {
        try { frame.contentWindow.postMessage(m, '*'); } catch (_) {}
      }
    };
    // Attempt at 1.5 s and again at 4 s (in case the player loads slowly)
    frame.addEventListener('load', () => {
      setTimeout(_doSeek, 1500);
      setTimeout(_doSeek, 4000);
    });
  }

  // Start the bar auto-hide: bar fades out after 3.5 s, returns on any key.
  _showPlayerBar();
}

function switchSrc(delta) {
  const srcs = _pl.mediaType === 'movie'
    ? SRCS.movie(_pl.id, _pl.resumeTs)
    : SRCS.tv(_pl.id, _pl.season, _pl.episode, _pl.resumeTs);
  _pl.src = (_pl.src + delta + srcs.length) % srcs.length;
  renderPlayer();
}

function onPlayerMsg(e) {
  try {
    const raw = e.data;
    if (!raw) return;
    const msg = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!msg || typeof msg !== 'object') return;

    // Normalise across every known iframe player message format
    let ev = null, currentTime = null;

    if (msg.type === 'PLAYER_EVENT') {
      // Legacy internal format
      ev          = msg.data?.event;
      currentTime = msg.data?.currentTime;
    } else if (msg.type === 'vidlink') {
      // VidLink: { type:'vidlink', data:{ type:'timeupdate', currentTime:X } }
      ev          = msg.data?.type;
      currentTime = msg.data?.currentTime ?? msg.data?.time;
    } else if (msg.type === 'timeupdate' || msg.event === 'timeupdate') {
      ev          = 'timeupdate';
      currentTime = msg.currentTime ?? msg.time ?? msg.data?.currentTime;
    } else if (msg.type === 'play' || msg.type === 'playing' || msg.event === 'play') {
      ev          = 'play';
      currentTime = msg.currentTime ?? msg.data?.currentTime;
    } else if (msg.type === 'pause' || msg.event === 'pause') {
      ev          = 'pause';
      currentTime = msg.currentTime ?? msg.data?.currentTime;
    } else if (msg.type === 'seeked' || msg.event === 'seeked') {
      ev          = 'seeked';
      currentTime = msg.currentTime ?? msg.data?.currentTime;
    } else if (typeof msg.currentTime === 'number') {
      // Generic fallback — any message that carries a currentTime
      ev          = 'timeupdate';
      currentTime = msg.currentTime;
    }

    if (!ev) return;

    // Stream-started detection
    if (['play', 'playing', 'start'].includes(ev) && !_streamStarted) {
      _streamStarted = true;
      clearStreamTimer();
      document.getElementById('no-stream-overlay')?.remove();
    }

    // Position update — anchor the wall-clock estimate to the real iframe position
    if (['timeupdate', 'time', 'progress', 'pause', 'seeked'].includes(ev)
        && currentTime != null && +currentTime > 5) {
      const ct  = Math.floor(+currentTime);
      // Re-anchor wall-clock timer so drift stays near zero
      _watchBaseTs  = ct;
      _watchStartMs = Date.now();
      _pl.resumeTs  = ct;

      const now = Date.now();
      if (now - _lastSave >= 10_000) {
        _lastSave = now;
        saveProgress({
          tmdbId:         _pl.id,
          mediaType:      _pl.mediaType,
          title:          _pl.title,
          posterPath:     _pl.posterPath,
          season:         _pl.season,
          episode:        _pl.episode,
          watchTimestamp: ct,
          updatedAt:      now,
        });
      }
    }
  } catch (_) {}
}

/* ═══════════════════════════════════════════════════════════════════
   SEARCH SCREEN
═══════════════════════════════════════════════════════════════════ */
let _searchTimer = null;

function openSearch() {
  navigateTo('search', () => {
    document.getElementById('search-box').value = '';
    document.getElementById('search-results').innerHTML =
      '<p class="placeholder">Type to search movies and TV shows…</p>';
  });
  setTimeout(() => {
    const box = document.getElementById('search-box');
    setFocus(box, false);
    box.focus();
  }, 80);
}

function bindSearch() {
  document.getElementById('btn-search-back').onclick = goBack;
  const box = document.getElementById('search-box');
  box.addEventListener('input', () => {
    clearTimeout(_searchTimer);
    _searchTimer = setTimeout(() => doSearch(box.value), 400);
  });
  document.getElementById('search-results').addEventListener('click', e => {
    const card = e.target.closest('.card[data-id]');
    if (card) openDetail(+card.dataset.id, card.dataset.type);
  });
}

async function doSearch(q) {
  if (!q.trim()) return;
  const res = document.getElementById('search-results');
  res.innerHTML = spinner();
  try {
    const data  = await tmdb('/search/multi', { query: q.trim(), include_adult: 'false' });
    const items = data.results
      .filter(r => r.media_type === 'movie' || r.media_type === 'tv')
      .slice(0, 40);
    if (!items.length) { res.innerHTML = '<p class="placeholder">No results found.</p>'; return; }
    res.innerHTML = items.map(item =>
      makeCard(item.id, item.media_type, item.poster_path,
        item.title || item.name || '',
        item.vote_average ? '★ ' + item.vote_average.toFixed(1) : '',
        'detail')
    ).join('');
    requestAnimationFrame(() => setFocus(res.querySelector('.focusable'), false));
  } catch (err) {
    res.innerHTML = `<p class="err">⚠ ${h(err.message)}</p>`;
  }
}

/* ═══════════════════════════════════════════════════════════════════
   UTILITIES
═══════════════════════════════════════════════════════════════════ */
function h(s) {
  return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function a(s) {
  return String(s ?? '').replace(/"/g,'&quot;').replace(/'/g,'&#x27;');
}
function spinner() {
  return '<div class="spin-wrap"><div class="spinner"></div></div>';
}

/* ═══════════════════════════════════════════════════════════════════
   BOOT
═══════════════════════════════════════════════════════════════════ */
document.addEventListener('DOMContentLoaded', async () => {

  await loadConfig();

  const { data: { session } } = await supa.auth.getSession();
  if (session) {
    _session = session;
    await loadProfile(session.user.id);
  }

  supa.auth.onAuthStateChange(async (event, sess) => {
    if (event === 'SIGNED_IN' && sess) {
      await onSignedIn(sess);
    } else if (event === 'SIGNED_OUT') {
      _session = null; _profile = null;
      updateNavAuth();
    } else if (event === 'PASSWORD_RECOVERY' && sess) {
      _session = sess;
      openPasswordReset();
    }
  });

  updateNavAuth();

  document.getElementById('btn-nav-search').onclick = openSearch;
  document.getElementById('btn-nav-signin').onclick = openAuth;

  document.getElementById('btn-avatar').onclick = toggleDropdown;
  document.querySelectorAll('.dropdown-item').forEach(btn => {
    btn.addEventListener('click', () => {
      const action = btn.dataset.dd;
      if (action === 'settings') openSettings();
      if (action === 'signout')  handleSignOut();
    });
  });
  document.addEventListener('click', e => {
    if (!document.getElementById('user-menu-wrap')?.contains(e.target)) closeDropdown();
  });

  document.querySelectorAll('.auth-tab').forEach(btn =>
    btn.addEventListener('click', () => switchAuthTab(btn.dataset.tab))
  );
  document.querySelectorAll('.mode-tab').forEach(btn =>
    btn.addEventListener('click', () => switchLoginMode(btn.dataset.mode))
  );

  document.getElementById('btn-register').onclick   = doRegister;
  document.getElementById('btn-signin-pw').onclick  = doLoginPassword;
  document.getElementById('btn-send-otp').onclick   = doSendOtp;
  document.getElementById('btn-verify-otp').onclick = doVerifyOtp;
  document.getElementById('btn-otp-back').onclick   = () => {
    document.getElementById('otp-step-email').classList.remove('hidden');
    document.getElementById('otp-step-code').classList.add('hidden');
  };
  document.getElementById('btn-forgot-pw').onclick  = doForgotPassword;
  document.getElementById('btn-auth-back')?.addEventListener('click', goBack);

  document.getElementById('li-password').addEventListener('keydown', e => {
    if (e.key === 'Enter') doLoginPassword();
  });
  document.getElementById('li-otp-code').addEventListener('keydown', e => {
    if (e.key === 'Enter') doVerifyOtp();
  });
  document.getElementById('reg-password').addEventListener('keydown', e => {
    if (e.key === 'Enter') doRegister();
  });

  document.getElementById('btn-settings-back').onclick = async () => {
    await saveSettings();
    goBack();
  };

  document.getElementById('btn-view-history').onclick = () => {
    goBack();
    setTimeout(() => openHistoryView('history'), 50);
  };
  document.getElementById('btn-view-favorites').onclick = () => {
    goBack();
    setTimeout(() => openHistoryView('favorites'), 50);
  };

  document.getElementById('btn-clear-history').onclick = async () => {
    if (await showConfirm('Clear your entire watch history? This cannot be undone.')) {
      await doClearHistory();
    }
  };
  document.getElementById('btn-reset-data').onclick = async () => {
    if (await showConfirm('Reset ALL your data (history + watchlist)? This cannot be undone.')) {
      await doResetData();
    }
  };
  document.getElementById('btn-delete-account').onclick = async () => {
    if (await showConfirm('Permanently delete your account and all data? This CANNOT be undone.')) {
      await doDeleteAccount();
    }
  };

  if (!window.isSecureContext) {
    const bar = document.createElement('div');
    bar.style.cssText = [
      'position:fixed','top:0','left:0','right:0','z-index:9999',
      'background:#e50914','color:#fff','padding:10px 24px',
      'font-size:14px','font-weight:700','text-align:center','line-height:1.5',
    ].join(';');
    bar.innerHTML =
      '⚠ Open this page at <strong>http://localhost:5500</strong> (not your IP address) ' +
      '— streaming requires a secure context that your current URL doesn\'t provide.';
    document.body.appendChild(bar);
    document.getElementById('home-scroll').style.paddingTop = '44px';
  }

  showView('home');
  bindSearch();
  initHome();
});
