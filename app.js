'use strict';

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
  } catch (err) {
    console.error('JasMovies: could not load config –', err.message);
    document.body.innerHTML = `<div style="display:flex;align-items:center;justify-content:center;
      height:100vh;flex-direction:column;gap:16px;background:#141414;color:#fff;font-family:sans-serif">
      <div style="font-size:48px">⚠️</div>
      <div style="font-size:22px;font-weight:800">Failed to load configuration</div>
      <div style="font-size:14px;color:#999;max-width:420px;text-align:center;line-height:1.7">
        Could not reach the config service. Check your internet connection or Supabase Edge Function status.
      </div>
      <button onclick="location.reload()" style="background:#e50914;color:#fff;padding:12px 28px;
        border-radius:6px;font-size:16px;font-weight:700;border:none;cursor:pointer;margin-top:8px">
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
  await supa.from('watch_progress').upsert({
    user_id:         uid,
    tmdb_id:         entry.tmdbId,
    media_type:      entry.mediaType,
    title:           entry.title || '',
    poster_path:     entry.posterPath || null,
    season:          entry.season  || 1,
    episode:         entry.episode || 1,
    watch_timestamp: entry.watchTimestamp || 0,
  }, { onConflict: 'user_id,tmdb_id,media_type' });
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
  const W = window.innerWidth, H = window.innerHeight;
  const all = [...document.querySelectorAll('.focusable')].filter(el => {
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

document.addEventListener('keydown', e => {
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

function goBack() {
  if (!navStack.length) return;
  const prev = navStack.pop();
  if (active === 'player') killPlayer();
  showView(prev);
  $f = null;
  if (prev === 'home') refreshContinueWatching();
  requestAnimationFrame(() => focusFirst(document.getElementById('view-' + prev)));
}

function killPlayer() {
  clearStreamTimer();
  window.removeEventListener('message', onPlayerMsg);
  const f = document.getElementById('player-frame');
  if (f) f.src = 'about:blank';
  _justExitedPlayer = true;
  setTimeout(() => { _justExitedPlayer = false; }, 500);
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

async function initHome() {
  if (homeLoaded) return;
  homeLoaded = true;

  const scroll = document.getElementById('home-scroll');
  scroll.innerHTML = spinner();

  try {
    const [tr, pop, top, now, ptv, ttv, trtv,
           act, sci, hor, com, rom, ani, doc, thr, fam,
           usm, ukm, esm, inm, cnm, jpm, krm, dem, itm,
           ustv, krtv, jptv, intv] = await Promise.all([
      // Core
      tmdb('/trending/movie/week'),
      tmdb('/movie/popular'),
      tmdb('/movie/top_rated'),
      tmdb('/movie/now_playing'),
      tmdb('/tv/popular'),
      tmdb('/tv/top_rated'),
      tmdb('/trending/tv/week'),
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

    heroItem = tr.results[0] || pop.results[0];
    heroType = 'movie';

    const cwHtml = await buildContinueWatching();

    scroll.innerHTML =
      buildHero(heroItem) +
      cwHtml +
      buildRow('🔥 Trending Now',       tr.results,   'movie', { path: '/trending/movie/week' }) +
      buildRow('🎬 Popular Movies',     pop.results,  'movie', { path: '/movie/popular' }) +
      buildRow('⭐ Top Rated Movies',   top.results,  'movie', { path: '/movie/top_rated' }) +
      buildRow('🎭 Now Playing',        now.results,  'movie', { path: '/movie/now_playing' }) +
      buildRow('📺 Popular TV Shows',   ptv.results,  'tv',    { path: '/tv/popular' }) +
      buildRow('🏆 Top Rated TV',       ttv.results,  'tv',    { path: '/tv/top_rated' }) +
      buildRow('📡 Trending TV',        trtv.results, 'tv',    { path: '/trending/tv/week' }) +
      buildRow('💥 Action',             act.results,  'movie', { path: '/discover/movie', params: { with_genres: '28',    sort_by: 'popularity.desc', 'vote_count.gte': '200' } }) +
      buildRow('🚀 Sci-Fi',             sci.results,  'movie', { path: '/discover/movie', params: { with_genres: '878',   sort_by: 'popularity.desc', 'vote_count.gte': '200' } }) +
      buildRow('👻 Horror',             hor.results,  'movie', { path: '/discover/movie', params: { with_genres: '27',    sort_by: 'popularity.desc', 'vote_count.gte': '200' } }) +
      buildRow('😂 Comedy',             com.results,  'movie', { path: '/discover/movie', params: { with_genres: '35',    sort_by: 'popularity.desc', 'vote_count.gte': '200' } }) +
      buildRow('💕 Romance',            rom.results,  'movie', { path: '/discover/movie', params: { with_genres: '10749', sort_by: 'popularity.desc', 'vote_count.gte': '200' } }) +
      buildRow('🎨 Animation',          ani.results,  'movie', { path: '/discover/movie', params: { with_genres: '16',    sort_by: 'popularity.desc', 'vote_count.gte': '200' } }) +
      buildRow('🎙 Documentary',        doc.results,  'movie', { path: '/discover/movie', params: { with_genres: '99',    sort_by: 'popularity.desc', 'vote_count.gte': '100' } }) +
      buildRow('🔪 Thriller',           thr.results,  'movie', { path: '/discover/movie', params: { with_genres: '53',    sort_by: 'popularity.desc', 'vote_count.gte': '200' } }) +
      buildRow('👨‍👩‍👧 Family',             fam.results,  'movie', { path: '/discover/movie', params: { with_genres: '10751', sort_by: 'popularity.desc', 'vote_count.gte': '200' } }) +
      buildSectionHeader('🌍 Around the World') +
      buildRow('🇺🇸 American',           usm.results,  'movie', { path: '/discover/movie', params: { with_origin_country: 'US',       sort_by: 'popularity.desc', 'vote_count.gte': '300' } }) +
      buildRow('🇬🇧 British',            ukm.results,  'movie', { path: '/discover/movie', params: { with_origin_country: 'GB',       sort_by: 'popularity.desc', 'vote_count.gte': '100' } }) +
      buildRow('🇪🇸 Latino / Spanish',   esm.results,  'movie', { path: '/discover/movie', params: { with_original_language: 'es',    sort_by: 'popularity.desc', 'vote_count.gte': '100' } }) +
      buildRow('🇮🇳 Bollywood & Indian', inm.results,  'movie', { path: '/discover/movie', params: { with_origin_country: 'IN',       sort_by: 'popularity.desc', 'vote_count.gte': '100' } }) +
      buildRow('🇨🇳 Chinese Cinema',     cnm.results,  'movie', { path: '/discover/movie', params: { with_origin_country: 'CN|HK|TW', sort_by: 'popularity.desc', 'vote_count.gte': '100' } }) +
      buildRow('🇯🇵 Japanese Cinema',    jpm.results,  'movie', { path: '/discover/movie', params: { with_origin_country: 'JP',       sort_by: 'popularity.desc', 'vote_count.gte': '100' } }) +
      buildRow('🇰🇷 Korean Cinema',      krm.results,  'movie', { path: '/discover/movie', params: { with_origin_country: 'KR',       sort_by: 'popularity.desc', 'vote_count.gte': '100' } }) +
      buildRow('🇩🇪 German Cinema',      dem.results,  'movie', { path: '/discover/movie', params: { with_origin_country: 'DE',       sort_by: 'popularity.desc', 'vote_count.gte': '50'  } }) +
      buildRow('🇮🇹 Italian Cinema',     itm.results,  'movie', { path: '/discover/movie', params: { with_origin_country: 'IT',       sort_by: 'popularity.desc', 'vote_count.gte': '50'  } }) +
      buildSectionHeader('📺 International TV') +
      buildRow('🇺🇸 American TV',        ustv.results, 'tv',    { path: '/discover/tv', params: { with_origin_country: 'US', sort_by: 'popularity.desc', 'vote_count.gte': '100' } }) +
      buildRow('🇰🇷 K-Drama',            krtv.results, 'tv',    { path: '/discover/tv', params: { with_origin_country: 'KR', sort_by: 'popularity.desc', 'vote_count.gte': '50'  } }) +
      buildRow('🇯🇵 Japanese TV',        jptv.results, 'tv',    { path: '/discover/tv', params: { with_origin_country: 'JP', sort_by: 'popularity.desc', 'vote_count.gte': '50'  } }) +
      buildRow('🇮🇳 Indian TV',          intv.results, 'tv',    { path: '/discover/tv', params: { with_origin_country: 'IN', sort_by: 'popularity.desc', 'vote_count.gte': '50'  } }) +
      '<div style="height:52px"></div>';

    // ── Infinite scroll: load next TMDB page when sentinel enters view ──
    initRowInfiniteScroll(scroll);

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
  const rat   = item.vote_average ? item.vote_average.toFixed(1) : '';
  const bd    = backdropUrl(item.backdrop_path);
  return `<div id="hero">
    ${bd ? `<img id="hero-bg" src="${bd}" alt="">` : '<div id="hero-bg"></div>'}
    <div id="hero-grad"></div>
    <div id="hero-info">
      <div id="hero-title">${h(title)}</div>
      <div id="hero-meta">${h([year, rat ? '★ ' + rat : ''].filter(Boolean).join('  ·  '))}</div>
      <div id="hero-desc">${h(item.overview || '')}</div>
      <div id="hero-btns">
        <button id="btn-hero-play" class="btn-white focusable" tabindex="0"
          data-action="play" data-id="${item.id}" data-type="movie"
          data-title="${a(title)}" data-poster="${a(item.poster_path||'')}">▶  Play</button>
        <button id="btn-hero-info" class="btn-ghost focusable" tabindex="0"
          data-action="detail" data-id="${item.id}" data-type="movie">ⓘ  More Info</button>
      </div>
    </div>
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
      ? await tmdb(`/movie/${id}`, { append_to_response: 'credits' })
      : await tmdb(`/tv/${id}`,    { append_to_response: 'credits' });
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

  const title   = data.title || data.name || '';
  const year    = (data.release_date || data.first_air_date || '').slice(0, 4);
  const rat     = data.vote_average ? '★ ' + data.vote_average.toFixed(1) : '';
  const runtime = data.runtime ? data.runtime + ' min' : '';
  const meta    = [year, rat, runtime, mediaType === 'tv' ? 'TV Series' : 'Movie'].filter(Boolean).join('  ·  ');
  const prog    = await getProgress(mediaType, id);
  const bd      = bigBdUrl(data.backdrop_path);

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
        `<button class="ep-btn focusable" tabindex="0" data-ep="${ep.episode_number}">E${ep.episode_number}${ep.name ? ' · ' + h(ep.name.slice(0, 30)) : ''}</button>`
      ).join('');
    } catch (_) {}
    epHTML = `<div id="ep-section">
      <div class="ep-hdr">Episodes</div>
      <div id="season-row">${sBtns}</div>
      <div id="ep-grid">${eBtns}</div>
    </div>`;
  }

  const resumeBtn = prog ? (() => {
    const ts = prog.watchTimestamp || 0;
    const tsFmt = ts > 0 ? ` · ${fmtTs(ts)}` : '';
    const label = mediaType === 'tv'
      ? `↩ Resume S${prog.season} E${prog.episode}${tsFmt}`
      : `↩ Resume${tsFmt}`;
    return `
      <button id="btn-resume" class="btn-resume focusable" tabindex="0"
        data-ts="${ts}" data-season="${prog.season||1}" data-episode="${prog.episode||1}">${label}</button>
      <button id="btn-start-over" class="btn-back focusable" tabindex="0">↺ Start Over</button>`;
  })() : '';

  const isFav = await isFavorite(mediaType, id);

  document.getElementById('view-detail').innerHTML = `
    ${bd ? `<img id="detail-bg" src="${bd}" alt="">` : ''}
    <div id="detail-grad"></div>
    <div id="detail-scroll">
      <div id="detail-body">
        <img id="detail-poster" src="${posterUrl(data.poster_path)}" alt="${a(title)}">
        <div id="detail-info">
          <div id="detail-title">${h(title)}</div>
          <div id="detail-meta">${h(meta)}</div>
          <div id="detail-overview">${h(data.overview || '')}</div>
          <div id="detail-btns">
            <button id="btn-play"  class="btn-play  focusable" tabindex="0">▶  Play</button>
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
    </div>`;

  const view = document.getElementById('view-detail');
  view.querySelector('#btn-play').onclick =
    () => openPlayer(id, mediaType, curSeason, 1, title, data.poster_path);
  const resumeEl = view.querySelector('#btn-resume');
  if (resumeEl) {
    resumeEl.addEventListener('click', () => {
      const ts = +(resumeEl.dataset.ts  || 0);
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
  setFocus(view.querySelector('#btn-play'), false);
}

/* ═══════════════════════════════════════════════════════════════════
   PLAYER SCREEN
═══════════════════════════════════════════════════════════════════ */
let _pl = {};
let _lastSave = 0;
let _streamTimer = null;
let _streamStarted = false;

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
      `https://www.vidking.net/embed/movie/${id}?color=e50914&autoPlay=true${t?'&t='+t:''}`,
      `https://myembed.biz/filme/${id}?autoplay=true${t?'&t='+t:''}`,
      `https://vidsrc.me/embed/movie?tmdb=${id}&ds_lang=hi&autoplay=true${t?'&t='+t:''}`,
      `https://multiembed.mov/?video_id=${id}&tmdb=1&lang=fr&autoplay=true${t?'&t='+t:''}`,
      `https://vidsrc.me/embed/movie?tmdb=${id}&ds_lang=ja&autoplay=true${t?'&t='+t:''}`,
      `https://vidsrc.me/embed/movie?tmdb=${id}&ds_lang=zh&autoplay=true${t?'&t='+t:''}`,
      `https://vidlink.pro/movie/${id}?autoplay=true${t?'&t='+t:''}`,
      `https://player.videasy.net/movie/${id}?autoplay=true${t?'&t='+t:''}`,
      `https://vidsrc.me/embed/movie?tmdb=${id}&autoplay=true${t?'&t='+t:''}`,
      `https://www.2embed.stream/embed/movie/${id}?autoplay=true${t?'&t='+t:''}`,
      `https://vidfast.pro/movie/${id}?autoPlay=true${t?'&t='+t:''}`,
      `https://multiembed.mov/?video_id=${id}&tmdb=1&autoplay=true${t?'&t='+t:''}`,
      `https://vidora.su/embed/movie/${id}?autoplay=true${t?'&t='+t:''}`,
      `https://player.mappletv.uk/watch/movie/${id}?autoplay=true${t?'&t='+t:''}`,
    ];
  },
  tv: (id, s, e, ts) => {
    const t = (ts > 5) ? Math.floor(ts) : 0;
    return [
      `https://www.vidking.net/embed/tv/${id}/${s}/${e}?color=e50914&autoPlay=true&nextEpisode=true&episodeSelector=true${t?'&t='+t:''}`,
      `https://myembed.biz/serie/${id}/${s}/${e}?autoplay=true${t?'&t='+t:''}`,
      `https://vidsrc.me/embed/tv?tmdb=${id}&season=${s}&episode=${e}&ds_lang=hi&autoplay=true${t?'&t='+t:''}`,
      `https://multiembed.mov/?video_id=${id}&tmdb=1&s=${s}&e=${e}&lang=fr&autoplay=true${t?'&t='+t:''}`,
      `https://vidsrc.me/embed/tv?tmdb=${id}&season=${s}&episode=${e}&ds_lang=ja&autoplay=true${t?'&t='+t:''}`,
      `https://vidsrc.me/embed/tv?tmdb=${id}&season=${s}&episode=${e}&ds_lang=zh&autoplay=true${t?'&t='+t:''}`,
      `https://vidlink.pro/tv/${id}/${s}/${e}?autoplay=true${t?'&t='+t:''}`,
      `https://player.videasy.net/tv/${id}/${s}/${e}?autoplay=true${t?'&t='+t:''}`,
      `https://vidsrc.me/embed/tv?tmdb=${id}&season=${s}&episode=${e}&autoplay=true${t?'&t='+t:''}`,
      `https://www.2embed.stream/embed/tv/${id}/${s}/${e}?autoplay=true${t?'&t='+t:''}`,
      `https://vidfast.pro/tv/${id}/${s}/${e}?autoPlay=true${t?'&t='+t:''}`,
      `https://multiembed.mov/?video_id=${id}&tmdb=1&s=${s}&e=${e}&autoplay=true${t?'&t='+t:''}`,
      `https://vidora.su/embed/tv/${id}/${s}/${e}?autoplay=true${t?'&t='+t:''}`,
      `https://player.mappletv.uk/watch/tv/${id}-${s}-${e}?autoplay=true${t?'&t='+t:''}`,
    ];
  },
};
const SRC_NAMES = [
  'Vidking', 'French',
  '🇮🇳 Indian', '🇫🇷 French(2)', '🇯🇵 Japanese', '🇨🇳 Chinese',
  'VidLink', 'VidEasy', 'Vidsrc', '2Embed', 'Vidfast', 'SuperEmbed', 'Vidora', 'Mapple',
];

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
  setFocus(document.getElementById('btn-p-exit'), false);
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
    const msg = typeof e.data === 'string' ? JSON.parse(e.data) : e.data;
    if (msg?.type !== 'PLAYER_EVENT') return;
    const { event: ev, currentTime } = msg.data || {};

    if (ev === 'play' && !_streamStarted) {
      _streamStarted = true;
      clearStreamTimer();
      document.getElementById('no-stream-overlay')?.remove();
    }

    if (['timeupdate', 'pause', 'seeked'].includes(ev) && currentTime > 5) {
      const now = Date.now();
      if (now - _lastSave > 10_000) {
        _lastSave = now;
        _pl.resumeTs = Math.floor(currentTime);
        saveProgress({
          tmdbId: _pl.id, mediaType: _pl.mediaType, title: _pl.title,
          posterPath: _pl.posterPath, backdropPath: null,
          season: _pl.season, episode: _pl.episode,
          watchTimestamp: Math.floor(currentTime), updatedAt: now,
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

  /* ── Ad / Popup Blocker ── */
  let _adToastTimer = null;
  function _showAdBlockedToast() {
    clearTimeout(_adToastTimer);
    let t = document.getElementById('ad-blocked-toast');
    if (!t) {
      t = document.createElement('div');
      t.id = 'ad-blocked-toast';
      document.body.appendChild(t);
    }
    t.textContent = '🛡 Ad blocked';
    t.classList.add('visible');
    _adToastTimer = setTimeout(() => t?.classList.remove('visible'), 2200);
  }

  window.open = (() => {
    const _orig = window.open.bind(window);
    return function(url, target, features) {
      if (active === 'player') { _showAdBlockedToast(); return null; }
      return _orig(url, target, features);
    };
  })();

  try {
    const _locProto = Object.getPrototypeOf(window.location);
    ['href', 'assign', 'replace'].forEach(prop => {
      const _orig = Object.getOwnPropertyDescriptor(_locProto, prop)
                 || Object.getOwnPropertyDescriptor(Location.prototype, prop);
      if (!_orig) return;
      const isFunc = typeof _orig.value === 'function';
      Object.defineProperty(_locProto, prop, {
        ...(isFunc
          ? { value: function(...args) {
                if (active === 'player') { _showAdBlockedToast(); return; }
                return _orig.value.apply(this, args);
              }
            }
          : { set(v) {
                if (active === 'player') { _showAdBlockedToast(); return; }
                _orig.set.call(this, v);
              },
              get() { return _orig.get ? _orig.get.call(this) : _orig.value; }
            }
        ),
        configurable: true,
      });
    });
  } catch (_) {}

  document.addEventListener('click', e => {
    const anchor = e.target.closest('a[target="_blank"], a[target="_new"], a[target="_top"]');
    if (anchor && active === 'player') {
      e.preventDefault();
      e.stopImmediatePropagation();
      _showAdBlockedToast();
    }
  }, true);

  const _mo = new MutationObserver(mutations => {
    if (active !== 'player') return;
    for (const m of mutations) {
      for (const node of m.addedNodes) {
        if (node.nodeType !== 1) continue;
        const anchors = node.tagName === 'A' ? [node] : [...node.querySelectorAll('a')];
        for (const anc of anchors) {
          const t = (anc.target || '').toLowerCase();
          if (t === '_blank' || t === '_new' || t === '_top') {
            anc.target = '_self';
            anc.rel    = 'noopener noreferrer';
            const href = anc.href || '';
            if (href && !href.startsWith(window.location.origin)) {
              anc.removeAttribute('href');
              anc.style.pointerEvents = 'none';
            }
          }
        }
      }
    }
  });
  _mo.observe(document.body, { childList: true, subtree: true });

  window.addEventListener('beforeunload', e => {
    if (active === 'player') { e.preventDefault(); e.returnValue = ''; }
  });

  history.pushState({ jm: true }, '');
  window.addEventListener('popstate', () => {
    if (active === 'player') {
      history.pushState({ jm: true }, '');
      _showAdBlockedToast();
    }
  });

  window.addEventListener('blur', () => {
    if (active !== 'player') return;
    if (_justExitedPlayer) return;
    setTimeout(() => { try { window.focus(); } catch (_) {} }, 40);
    _showAdBlockedToast();
  });

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
