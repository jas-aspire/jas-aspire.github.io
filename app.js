'use strict';

/* ═══════════════════════════════════════════════════════════════════
   CONFIG
═══════════════════════════════════════════════════════════════════ */
const TMDB_TOKEN = 'eyJhbGciOiJIUzI1NiJ9.eyJhdWQiOiI3MzAyNzVjOTI2NjdhYjk2ZDRhYTJjNzRlZWViZjYyZCIsIm5iZiI6MTc3OTU0NzA0My4yMDgsInN1YiI6IjZhMTFiYmEzZjhkMjA3Njk1MDg3NjhhOCIsInNjb3BlcyI6WyJhcGlfcmVhZCJdLCJ2ZXJzaW9uIjoxfQ.AwxLgTXDUtmO3CjBReEy7T2d6eLZKn3PmEVMr_igh48';
const TMDB = 'https://api.themoviedb.org/3';
const IMG  = 'https://image.tmdb.org/t/p';

const posterUrl   = p => p ? `${IMG}/w342${p}`    : 'https://placehold.co/342x513/1a1a1a/555?text=?';
const backdropUrl = p => p ? `${IMG}/w1280${p}`   : '';
const bigBdUrl    = p => p ? `${IMG}/original${p}`: '';

/** Format seconds → "1h 23m" or "45m" for resume labels */
function fmtTs(s) {
  s = Math.floor(s);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

/* ═══════════════════════════════════════════════════════════════════
   LOCAL STORAGE  ── Continue Watching
═══════════════════════════════════════════════════════════════════ */
const sk       = (mt, id) => `jm_${mt}_${id}`;
const RKEY     = 'jm_recents';
const MAX_RECS = 24;

function saveProgress(entry) {
  try {
    localStorage.setItem(sk(entry.mediaType, entry.tmdbId), JSON.stringify(entry));
    let list = JSON.parse(localStorage.getItem(RKEY) || '[]');
    list = list.filter(([mt, id]) => !(mt === entry.mediaType && id === entry.tmdbId));
    list.unshift([entry.mediaType, entry.tmdbId]);
    localStorage.setItem(RKEY, JSON.stringify(list.slice(0, MAX_RECS)));
  } catch (_) {}
}
function getProgress(mt, id) {
  try { return JSON.parse(localStorage.getItem(sk(mt, id))); } catch (_) { return null; }
}
function getRecents() {
  try {
    return JSON.parse(localStorage.getItem(RKEY) || '[]')
      .map(([mt, id]) => getProgress(mt, id)).filter(Boolean);
  } catch (_) { return []; }
}

/* ═══════════════════════════════════════════════════════════════════
   TMDB API
═══════════════════════════════════════════════════════════════════ */
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
   Every interactive element gets:  class="focusable" tabindex="0"
   Arrow keys → find nearest focusable in that direction.
   Enter       → click() the focused element.
   Back/Esc    → goBack().
═══════════════════════════════════════════════════════════════════ */
let $f = null;   // currently focused element

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
  // Let the system keyboard work normally in the search box
  if (e.target.tagName === 'INPUT') {
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
   ROUTER  ── simple view-stack navigation
═══════════════════════════════════════════════════════════════════ */
const navStack = [];
let   active   = 'home';

function showView(id) {
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.getElementById('view-' + id)?.classList.add('active');
  active = id;
}

// Push current view, switch to new one, run renderFn, then focus first element.
function navigateTo(id, renderFn) {
  navStack.push(active);
  showView(id);
  $f = null;
  renderFn?.();
  // Focus first .focusable after a tick so DOM is ready
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
    // Fetch all rows in parallel
    const [tr, pop, top, now, ptv, ttv, trtv, act, sci, hor, com] = await Promise.all([
      tmdb('/trending/movie/week'),
      tmdb('/movie/popular'),
      tmdb('/movie/top_rated'),
      tmdb('/movie/now_playing'),
      tmdb('/tv/popular'),
      tmdb('/tv/top_rated'),
      tmdb('/trending/tv/week'),
      tmdb('/discover/movie', { with_genres: '28', sort_by: 'popularity.desc', 'vote_count.gte': '100' }),
      tmdb('/discover/movie', { with_genres: '878', sort_by: 'popularity.desc', 'vote_count.gte': '100' }),
      tmdb('/discover/movie', { with_genres: '27',  sort_by: 'popularity.desc', 'vote_count.gte': '100' }),
      tmdb('/discover/movie', { with_genres: '35',  sort_by: 'popularity.desc', 'vote_count.gte': '100' }),
    ]);

    heroItem = tr.results[0] || pop.results[0];
    heroType = 'movie';

    scroll.innerHTML =
      buildHero(heroItem) +
      buildContinueWatching() +
      buildRow('🔥 Trending Now',       tr.results,   'movie') +
      buildRow('🎬 Popular Movies',     pop.results,  'movie') +
      buildRow('⭐ Top Rated Movies',   top.results,  'movie') +
      buildRow('🎭 Now Playing',        now.results,  'movie') +
      buildRow('📺 Popular TV Shows',   ptv.results,  'tv')    +
      buildRow('🏆 Top Rated TV',       ttv.results,  'tv')    +
      buildRow('📡 Trending TV',        trtv.results, 'tv')    +
      buildRow('💥 Action',             act.results,  'movie') +
      buildRow('🚀 Sci-Fi',             sci.results,  'movie') +
      buildRow('👻 Horror',             hor.results,  'movie') +
      buildRow('😂 Comedy',             com.results,  'movie') +
      '<div style="height:52px"></div>';

    // One delegated click listener for the entire scroll area
    scroll.addEventListener('click', onHomeClick);

    // Hero buttons
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
  if (action === 'detail')
    openDetail(+id, type);
  else if (action === 'play')
    openPlayer(+id, type, 1, 1, title || '', poster || null);
  else if (action === 'continue')
    openPlayer(+id, type, +(season || 1), +(episode || 1), title || '', poster || null);
}

function refreshContinueWatching() {
  // Called when returning to home from the player
  const existing = document.getElementById('cw-row');
  const html = buildContinueWatching();
  if (existing) {
    if (html) existing.outerHTML = html;
    else      existing.remove();
  } else {
    // Insert before first cat row
    const first = document.querySelector('#home-scroll .cat-row');
    if (first && html) first.insertAdjacentHTML('beforebegin', html);
  }
}

/* ── HTML builders ────────────────────────────────────── */

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

function buildContinueWatching() {
  const recs = getRecents();
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

function buildRow(title, items, type) {
  if (!items?.length) return '';
  const cards = items.slice(0, 20).map(item =>
    makeCard(item.id, type, item.poster_path, item.title || item.name || '',
      item.vote_average ? '★ ' + item.vote_average.toFixed(1) : '', 'detail')
  ).join('');
  return `<div class="cat-row">
    <div class="cat-title">${h(title)}</div>
    <div class="row-strip">${cards}</div>
  </div>`;
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
let _det = {};   // { id, mediaType, data, season }

async function openDetail(id, mediaType) {
  // ── FIX: set innerHTML on view-detail directly, NOT on detail-scroll
  // (detail-scroll doesn't exist until renderDetail creates it)
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
  const prog    = getProgress(mediaType, id);
  const bd      = bigBdUrl(data.backdrop_path);

  // ── Episode section for TV ──
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
    return `<button id="btn-resume" class="btn-resume focusable" tabindex="0">${label}</button>`;
  })() : '';

  // ── Inject full detail HTML into view-detail ──
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
            <button id="btn-dback" class="btn-back  focusable" tabindex="0">← Back</button>
          </div>
          ${epHTML}
        </div>
      </div>
    </div>`;

  const view = document.getElementById('view-detail');

  view.querySelector('#btn-play').onclick =
    () => openPlayer(id, mediaType, curSeason, 1, title, data.poster_path);
  view.querySelector('#btn-resume')?.addEventListener('click', () => {
    if (prog) openPlayer(id, mediaType, prog.season || 1, prog.episode || 1, title, data.poster_path);
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
   Sources:
     1. VidLink     – great quality, works in Firestick app
     2. MoviesAPI   – good backup, works in Firestick app
     3. Vidking     – embedded player, works in browser AND Firestick
   NOTE: Sources 1 & 2 may show blank in a regular browser because
   those sites block iframing. They work fine in the APK (WebView
   ignores X-Frame-Options). Use Source 3 for browser testing.
═══════════════════════════════════════════════════════════════════ */
let _pl = {};
let _lastSave = 0;
let _streamTimer = null;   // fires if no video starts within timeout window
let _streamStarted = false;

function startStreamTimer() {
  clearStreamTimer();
  _streamStarted = false;
  _streamTimer = setTimeout(() => {
    // Only show if we're still on the player screen
    if (active !== 'player') return;
    const wrap = document.getElementById('frame-wrap');
    if (!wrap) return;
    const { src } = _pl;
    const srcs = _pl.mediaType === 'movie'
      ? SRCS.movie(_pl.id, _pl.resumeTs)
      : SRCS.tv(_pl.id, _pl.season, _pl.episode, _pl.resumeTs);
    const isLast = src >= srcs.length - 1;

    // Inject overlay on top of the (stuck) iframe
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
  }, 30000);  // 30 seconds
}

function clearStreamTimer() {
  if (_streamTimer) { clearTimeout(_streamTimer); _streamTimer = null; }
}

// Vidking is first — it's built for embedding, loads instantly, works in browser + APK.
// VidLink / MoviesAPI block iframes in regular browsers (bot/X-Frame-Options); they
// work fine inside the Firestick APK where WebView ignores those headers.
const SRCS = {
  movie: (id, ts) => [
    `https://www.vidking.net/embed/movie/${id}?color=e50914&autoPlay=true${ts > 5 ? '&progress=' + Math.floor(ts) : ''}`,
    `https://vidlink.pro/movie/${id}`,
    `https://moviesapi.club/movie/${id}`,
  ],
  tv: (id, s, e, ts) => [
    `https://www.vidking.net/embed/tv/${id}/${s}/${e}?color=e50914&autoPlay=true&nextEpisode=true&episodeSelector=true${ts > 5 ? '&progress=' + Math.floor(ts) : ''}`,
    `https://vidlink.pro/tv/${id}/${s}/${e}`,
    `https://moviesapi.club/tv/${id}-${s}-${e}`,
  ],
};
const SRC_NAMES = ['Vidking', 'VidLink', 'MoviesAPI'];
// True = source is designed for iframe embedding (works in browser).
// False = source blocks iframes; works in Firestick APK but needs "open in tab" in browser.
const SRC_EMBEDDABLE = [true, false, false];

function openPlayer(id, mediaType, season, episode, title, posterPath) {
  season  = season  || 1;
  episode = episode || 1;
  title   = title   || '';

  const prog = getProgress(mediaType, id);
  const resumeTs = (prog && (mediaType === 'movie' ||
    (prog.season === season && prog.episode === episode)))
    ? (prog.watchTimestamp || 0) : 0;

  _pl = { id, mediaType, season, episode, title, posterPath: posterPath || null, src: 0, resumeTs };

  // Save immediately so the item appears in Continue Watching right away.
  // Preserve the existing watchTimestamp so the resume position is not wiped.
  const _existingProg = getProgress(mediaType, id);
  const _keepTs = (_existingProg && (mediaType === 'movie' ||
    (_existingProg.season === season && _existingProg.episode === episode)))
    ? (_existingProg.watchTimestamp || 0) : 0;
  saveProgress({
    tmdbId: id, mediaType, title,
    posterPath: posterPath || null, backdropPath: null,
    season, episode, updatedAt: Date.now(),
    ...((_keepTs > 0) ? { watchTimestamp: _keepTs } : {}),
  });

  navigateTo('player', renderPlayer);
  window.addEventListener('message', onPlayerMsg);
}

function renderPlayer() {
  const { id, mediaType, season, episode, title, src, resumeTs } = _pl;
  const srcs      = mediaType === 'movie' ? SRCS.movie(id, resumeTs) : SRCS.tv(id, season, episode, resumeTs);
  const url       = srcs[src];
  const srcName   = SRC_NAMES[src] || `Source ${src + 1}`;
  const embeddable = SRC_EMBEDDABLE[src] !== false;
  const display   = mediaType === 'tv' ? `${title}  ·  S${season} E${episode}` : title;

  // For non-embeddable sources (VidLink, MoviesAPI): show a friendly overlay
  // with an "Open in tab" button. The iframe is still there — it works in the
  // Firestick APK (WebView ignores X-Frame-Options) but not in a desktop browser.
  const overlay = embeddable ? '' : `
    <div id="player-overlay">
      <div style="font-size:48px">🔗</div>
      <div style="font-size:20px;font-weight:700;margin-bottom:6px">${h(srcName)}</div>
      <div style="font-size:14px;color:#888;margin-bottom:22px;max-width:380px;text-align:center;line-height:1.6">
        ${h(srcName)} doesn't allow embedding in a browser.<br>
        It works perfectly in the <strong>Firestick app</strong>.
      </div>
      <a id="btn-open-tab" href="${url}" target="_blank" rel="noopener"
         class="focusable"
         style="display:inline-block;background:#e50914;color:#fff;padding:13px 32px;
                border-radius:6px;font-size:17px;font-weight:800;text-decoration:none;
                border:3px solid transparent;">
        ↗ Open ${h(srcName)} in New Tab
      </a>
      <div style="margin-top:16px;font-size:13px;color:#555">
        or press ▶ to switch to Vidking (works here)
      </div>
    </div>`;

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
      ${overlay}
      ${embeddable ? `<iframe id="player-frame"
        src="${url}"
        allow="autoplay; encrypted-media; picture-in-picture; fullscreen"
        allowfullscreen>
      </iframe>` : ''}
    </div>`;

  document.getElementById('btn-p-exit').onclick   = goBack;
  document.getElementById('btn-src-prev').onclick = () => switchSrc(-1);
  document.getElementById('btn-src-next').onclick = () => switchSrc(+1);

  // Start the "no stream found" timeout only for embeddable sources (Vidking)
  if (embeddable) startStreamTimer();
  else clearStreamTimer();

  // Focus "Open in tab" for non-embeddable, otherwise the exit button
  const firstFocus = embeddable
    ? document.getElementById('btn-p-exit')
    : document.getElementById('btn-open-tab') || document.getElementById('btn-p-exit');
  setFocus(firstFocus, false);
}

function switchSrc(delta) {
  const srcs = _pl.mediaType === 'movie'
    ? SRCS.movie(_pl.id, _pl.resumeTs)
    : SRCS.tv(_pl.id, _pl.season, _pl.episode, _pl.resumeTs);
  _pl.src = (_pl.src + delta + srcs.length) % srcs.length;
  renderPlayer();
}

// Listens for Vidking postMessage events
function onPlayerMsg(e) {
  try {
    const msg = typeof e.data === 'string' ? JSON.parse(e.data) : e.data;
    if (msg?.type !== 'PLAYER_EVENT') return;
    const { event: ev, currentTime } = msg.data || {};

    // Video started → stream is working, kill the "no stream" timeout
    if (ev === 'play' && !_streamStarted) {
      _streamStarted = true;
      clearStreamTimer();
      // Also remove any "no stream" overlay that appeared while buffering
      document.getElementById('no-stream-overlay')?.remove();
    }

    // Save watch progress on timeupdate / pause / seeked
    if (['timeupdate', 'pause', 'seeked'].includes(ev) && currentTime > 5) {
      const now = Date.now();
      if (now - _lastSave > 10_000) {
        _lastSave = now;
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
  // Also give the input actual browser focus so typing works
  setTimeout(() => {
    const box = document.getElementById('search-box');
    setFocus(box, false);
    box.focus();
  }, 80);
}

// Bound once at startup (search view HTML is static)
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

    // Focus first result
    requestAnimationFrame(() =>
      setFocus(res.querySelector('.focusable'), false)
    );
  } catch (err) {
    res.innerHTML = `<p class="err">⚠ ${h(err.message)}</p>`;
  }
}

/* ═══════════════════════════════════════════════════════════════════
   UTILITIES
═══════════════════════════════════════════════════════════════════ */
// Escape HTML special chars for safe innerHTML injection
function h(s) {
  return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
// Escape for HTML attribute values
function a(s) {
  return String(s ?? '').replace(/"/g,'&quot;').replace(/'/g,'&#x27;');
}
// Loading spinner HTML
function spinner() {
  return '<div class="spin-wrap"><div class="spinner"></div></div>';
}

/* ═══════════════════════════════════════════════════════════════════
   BOOT
═══════════════════════════════════════════════════════════════════ */
document.addEventListener('DOMContentLoaded', () => {
  // ── Secure-context warning ──────────────────────────────────────────────────
  // crypto.subtle (needed by Vidking) only works in secure contexts.
  // localhost = secure even on HTTP. Any other IP/hostname requires HTTPS.
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
    // Push content down so the bar doesn't cover the nav
    document.getElementById('home-scroll').style.paddingTop = '44px';
  }

  showView('home');
  bindSearch();
  document.getElementById('btn-nav-search').onclick = openSearch;
  initHome();
});
