// ==UserScript==
// @name         Letterboxd ratings in Jellyfin
// @namespace    https://github.com/lehenandmartin
// @version      1.0.0
// @description  Enrich Jellyfin movie pages with Letterboxd ratings
// @author       lehenandmartin
// @match        https://jellyfin.example.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @connect      letterboxd.com
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  // ── User config ────────────────────────────────────────────────────────────

  const DEBUG         = false;               // Set to true to enable console logging
  const CACHE_TTL_MS  = 7 * 24 * 60 * 60 * 1000;  // 7 days — how long a cached rating is trusted

  // ── Constants ──────────────────────────────────────────────────────────────

  const DONE_ATTR  = 'data-lb-injected';
  const CACHE_KEY  = 'lb_cache';            // GM storage key for the persistent cache

  // ── State ──────────────────────────────────────────────────────────────────

  let lastItemId   = null;
  let pendingData  = null;  // { lbData, itemName } — set after fetch, consumed by tryInject()
  let fetchBusy    = false;
  let currentFetchId = null;  // token to detect stale fetches caused by fast navigation
  let lastHref    = location.href;
  let debounceTimer;

  // ── Logging ────────────────────────────────────────────────────────────────

  const log = {
    info:     (...a) => DEBUG && console.log  ('%c[LB]', 'color:#00c030;font-weight:bold', ...a),
    warn:     (...a) => DEBUG && console.warn ('%c[LB]', 'color:#ff8000;font-weight:bold', ...a),
    error:    (...a) =>          console.error('%c[LB]', 'color:#c0392b;font-weight:bold', ...a),
    group:    (l)    => DEBUG && console.group('%c[LB] ' + l, 'color:#40bcf4;font-weight:bold'),
    groupEnd: ()     => DEBUG && console.groupEnd(),
  };

  // ── Persistent cache ───────────────────────────────────────────────────────
  // Entries are stored as: { rating, count, url, cachedAt }
  // cachedAt is a Unix timestamp (ms); entries older than CACHE_TTL_MS are ignored.

  let memCache = null;  // in-memory mirror of GM storage, loaded once on startup

  async function cacheLoad() {
    if (memCache) return;
    try {
      const raw = await GM_getValue(CACHE_KEY, '{}');
      memCache = JSON.parse(raw);
    } catch {
      memCache = {};
    }
    log.info(`Cache loaded — ${Object.keys(memCache).length} entries`);
  }

  async function cacheGetOrNull(key) {
    await cacheLoad();
    const entry = memCache?.[key];
    if (!entry) return undefined;                                        // not in cache
    if (Date.now() - entry.cachedAt > CACHE_TTL_MS) {                   // expired
      delete memCache[key];
      log.info(`Cache expired for "${key}"`);
      return undefined;
    }
    log.info(`Cache hit for "${key}" (age: ${Math.round((Date.now() - entry.cachedAt) / 3600000)}h)`);
    if (entry.notFound) return null;                                     // cached "not found"
    const { cachedAt: _, notFound: __, ...data } = entry;
    return data;
  }

  async function cacheSet(key, value) {
    await cacheLoad();
    memCache[key] = value === null
      ? { notFound: true, cachedAt: Date.now() }
      : { ...value, cachedAt: Date.now() };
    try {
      await GM_setValue(CACHE_KEY, JSON.stringify(memCache));
    } catch (e) {
      log.error('Failed to persist cache:', e);
    }
  }

  // ── Auth helpers ───────────────────────────────────────────────────────────

  // Reads the Jellyfin access token from localStorage.
  // Jellyfin's apiclient persists credentials as { Servers: [{ AccessToken }] }.
  function getAuthToken() {
    try {
      for (const key of Object.keys(localStorage)) {
        const val = localStorage.getItem(key);
        if (!val) continue;
        try {
          const p = JSON.parse(val);
          if (p?.AccessToken)   return p.AccessToken;
          if (Array.isArray(p)) { for (const e of p) if (e?.AccessToken) return e.AccessToken; }
          if (p?.Servers)       { for (const s of p.Servers) if (s?.AccessToken) return s.AccessToken; }
        } catch {}
      }
    } catch {}
    log.warn('No auth token found in localStorage');
    return null;
  }

  // Extracts the 32-char hex Jellyfin item ID from the URL.
  // Jellyfin uses hash routing: /web/#/details?id=<32hex>&serverId=...
  function getItemIdFromUrl() {
    const m = location.href.match(/[?&]id=([a-f0-9]{32})/i);
    return m ? m[1] : null;
  }

  // ── Jellyfin API ───────────────────────────────────────────────────────────

  function jellyfinGet(path) {
    const token   = getAuthToken();
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = `MediaBrowser Token="${token}"`;
    const url = `${location.protocol}//${location.host}${path}`;
    log.info('Jellyfin →', url);
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'GET', url, headers,
        onload: r => {
          log.info(`Jellyfin ← HTTP ${r.status}`);
          if (r.status === 401) log.error('HTTP 401 — bad/missing token');
          try   { resolve(JSON.parse(r.responseText)); }
          catch { reject(new Error('JSON parse error')); }
        },
        onerror:   e  => reject(e),
        ontimeout: () => reject(new Error('timeout')),
        timeout: 8000,
      });
    });
  }

  // ── Letterboxd fetch & scrape ──────────────────────────────────────────────

  function lbFetch(url) {
    log.info('Letterboxd →', url);
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'GET', url,
        headers: { 'User-Agent': navigator.userAgent, 'Accept-Language': 'en-US,en;q=0.9' },
        onload:    r  => { log.info(`Letterboxd ← HTTP ${r.status}, finalUrl: ${r.finalUrl || url}`); resolve({ html: r.responseText, finalUrl: r.finalUrl || url }); },
        onerror:   e  => reject(e),
        ontimeout: () => reject(new Error('timeout')),
        timeout: 12000,
      });
    });
  }

  function parseRating(html) {
    const m = html.match(/<meta\s+itemprop="ratingValue"\s+content="([\d.]+)"/i)
           || html.match(/<meta\s+content="([\d.]+)"\s+itemprop="ratingValue"/i)
           || html.match(/"ratingValue"\s*:\s*([\d.]+)/);
    if (m) { log.info('ratingValue:', m[1]); return parseFloat(m[1]); }
    log.warn('ratingValue not found in HTML');
    return null;
  }

  function parseRatingCount(html) {
    const m = html.match(/"ratingCount"\s*:\s*(\d+)/);
    return m ? parseInt(m[1], 10) : null;
  }

  // Resolves via letterboxd.com/imdb/<id>/ which redirects to the film page.
  async function fetchByImdbId(imdbId) {
    await cacheLoad();
    const cached = await cacheGetOrNull(imdbId);
    if (cached !== undefined) return cached;

    let html, finalUrl;
    try   { ({ html, finalUrl } = await lbFetch(`https://letterboxd.com/imdb/${imdbId}/`)); }
    catch { return null; }
    log.info('Redirected to:', finalUrl);
    if (!finalUrl.includes('/film/') && !html.includes('"ratingValue"')) {
      log.warn('IMDB ID not found on Letterboxd');
      await cacheSet(imdbId, null);
      return null;
    }
    const result = { rating: parseRating(html), count: parseRatingCount(html), url: finalUrl };
    await cacheSet(imdbId, result);
    return result;
  }

  // Last-resort fallback using OriginalTitle (usually English) + year.
  async function fetchByTitleFallback(item) {
    const title = item?.OriginalTitle || item?.Name;
    const year  = item?.ProductionYear;
    log.warn(`Title fallback: "${title}" (${year})`);
    if (!title) return null;

    await cacheLoad();
    const key    = `t:${title}|${year}`;
    const cached = await cacheGetOrNull(key);
    if (cached !== undefined) return cached;

    let searchHtml;
    try   { ({ html: searchHtml } = await lbFetch(`https://letterboxd.com/search/films/${encodeURIComponent(title)}/`)); }
    catch { return null; }
    const slugRegex = /href="(\/film\/[^/"]+\/)"/g;
    const slugs = []; let m;
    while ((m = slugRegex.exec(searchHtml)) !== null) if (!slugs.includes(m[1])) slugs.push(m[1]);
    log.info('Slugs found:', slugs.slice(0, 5));
    for (const slug of slugs.slice(0, 3)) {
      let filmHtml;
      try { ({ html: filmHtml } = await lbFetch(`https://letterboxd.com${slug}`)); } catch { continue; }
      if (year) {
        const ym = filmHtml.match(/"releaseYear"\s*:\s*"?(\d{4})"?/);
        if (ym && Math.abs(parseInt(ym[1]) - year) > 1) { log.warn('Year mismatch, skip', slug); continue; }
      }
      const rating = parseRating(filmHtml);
      if (rating !== null) {
        const result = { rating, count: parseRatingCount(filmHtml), url: `https://letterboxd.com${slug}` };
        await cacheSet(key, result);
        return result;
      }
    }
    await cacheSet(key, null);
    return null;
  }

  // Fetches Jellyfin item metadata, guards against non-movies, then fetches Letterboxd data.
  async function fetchLetterboxdData(itemId) {
    log.group(`fetchLetterboxdData(${itemId})`);
    let item;
    try   { item = await jellyfinGet(`/Items/${itemId}?Fields=ProviderIds,OriginalTitle`); }
    catch { log.error('Jellyfin API failed'); log.groupEnd(); return null; }

    log.info(`Type: ${item?.Type} | Name: ${item?.Name} | OriginalTitle: ${item?.OriginalTitle} | Year: ${item?.ProductionYear}`);
    log.info('ProviderIds:', item?.ProviderIds);

    if (item?.Type !== 'Movie') {
      log.info(`Skipping — Type is "${item?.Type}"`);
      log.groupEnd();
      return undefined;
    }

    const imdbId = item?.ProviderIds?.Imdb || item?.ProviderIds?.IMDB;
    log.info('IMDB ID:', imdbId ?? 'NONE');
    const lbData = imdbId ? await fetchByImdbId(imdbId) : await fetchByTitleFallback(item);
    log.info('Result:', lbData);
    log.groupEnd();
    return lbData;
  }

  // ── DOM builders ───────────────────────────────────────────────────────────

  function ratingColor(r) { return r >= 3.5 ? '#00c030' : r >= 2.5 ? '#ff8000' : '#c0392b'; }

  function wrapInMediaInfoItem(inner) {
    const div = document.createElement('div');
    div.className = 'mediaInfoItem';
    div.appendChild(inner);
    return div;
  }

  const LB_LOGO = `<svg width="16" height="16" viewBox="0 0 200 200" xmlns="http://www.w3.org/2000/svg" style="flex-shrink:0;display:block">
    <circle cx="55"  cy="100" r="55" fill="#00e054"/>
    <circle cx="100" cy="100" r="55" fill="#40bcf4" opacity="0.9"/>
    <circle cx="145" cy="100" r="55" fill="#ff8000" opacity="0.9"/>
  </svg>`;

  // Rating chip shown in the media info row, before the "ends at" item.
  function buildRatingChip(lbData) {
    const a = document.createElement('a');
    a.href   = lbData.url;
    a.target = '_blank';
    a.rel    = 'noopener noreferrer';
    a.style.cssText = 'display:inline-flex;align-items:center;gap:5px;text-decoration:none;cursor:pointer;';
    a.innerHTML = LB_LOGO;
    if (lbData.rating === null) {
      a.title = 'On Letterboxd — no ratings yet';
      const t = document.createElement('span');
      t.textContent = '—';
      a.appendChild(t);
    } else {
      const { rating, count } = lbData;
      a.title = `Letterboxd: ${rating.toFixed(2)}/5${count ? ` — ${count.toLocaleString()} ratings` : ''}`;
      const s = document.createElement('span');
      s.style.cssText = `font-weight:700;color:${ratingColor(rating)};`;
      s.textContent   = rating.toFixed(1);  // e.g. "3.7", like Letterboxd displays
      a.appendChild(s);
    }
    return wrapInMediaInfoItem(a);
  }

  // Fallback chip shown when the film wasn't found, links to a Letterboxd search.
  function buildNotFoundChip(query) {
    const a = document.createElement('a');
    a.href   = `https://letterboxd.com/search/${encodeURIComponent(query)}/`;
    a.target = '_blank';
    a.rel    = 'noopener noreferrer';
    a.title  = 'Not found on Letterboxd — click to search';
    a.style.cssText = 'display:inline-flex;align-items:center;gap:4px;opacity:.5;text-decoration:none;';
    a.innerHTML = LB_LOGO + '<span>N/A</span>';
    return wrapInMediaInfoItem(a);
  }

  // External link styled identically to the existing IMDb / TMDB buttons.
  function buildExternalLink(url) {
    const a = document.createElement('a');
    a.setAttribute('is', 'emby-linkbutton');
    a.className   = 'button-link emby-button';
    a.href        = url;
    a.target      = '_blank';
    a.textContent = 'Letterboxd';
    return a;
  }

  // ── Injection ──────────────────────────────────────────────────────────────

  function tryInject() {
    if (!pendingData) return false;

    // The .endsAt element is used as the insertion anchor for the rating chip.
    // It appears in the media info row alongside year, duration, rating, etc.
    const endsAt = document.querySelector(`.endsAt.mediaInfoItem:not([${DONE_ATTR}])`);
    if (!endsAt) { log.warn('.endsAt not in DOM yet — will retry'); return false; }

    endsAt.setAttribute(DONE_ATTR, '1');

    const { lbData, itemName } = pendingData;
    pendingData = null;

    // 1. Rating chip
    const chip = lbData ? buildRatingChip(lbData) : buildNotFoundChip(itemName);
    endsAt.insertAdjacentElement('beforebegin', chip);
    log.info(lbData ? `✅ Chip: ${lbData.rating?.toFixed(1) ?? '—'} — ${lbData.url}` : '❌ N/A chip');

    // 2. External link (only when we have a confirmed Letterboxd URL)
    if (lbData?.url) {
      const extContainer = document.querySelector('.itemExternalLinks:not([data-lb-link])');
      if (extContainer) {
        extContainer.setAttribute('data-lb-link', '1');
        extContainer.appendChild(document.createTextNode(', '));
        extContainer.appendChild(buildExternalLink(lbData.url));
        log.info('✅ External link injected');
      } else {
        log.warn('.itemExternalLinks not found — external link skipped');
      }
    }

    return true;
  }

  // ── Orchestration ──────────────────────────────────────────────────────────

  async function onNewItem(itemId) {
    // Assign a unique token for this fetch. If navigation happens before it
    // completes, currentFetchId will have changed and the result is discarded.
    const fetchId  = Symbol();
    currentFetchId = fetchId;
    fetchBusy      = true;
    pendingData    = null;
    log.info(`▶ onNewItem(${itemId})`);

    // fetchLetterboxdData returns undefined for non-movies (skipped early),
    // null for movies not found on Letterboxd, or a data object on success.
    let lbData;
    try   { lbData = await fetchLetterboxdData(itemId); }
    catch { log.error('Unexpected error'); fetchBusy = false; return; }

    // A newer fetch has started — discard this result entirely
    if (currentFetchId !== fetchId) {
      log.warn(`Discarding stale fetch result for item ${itemId}`);
      fetchBusy = false;
      return;
    }

    // undefined means the item was not a movie — abort silently
    if (lbData === undefined) { fetchBusy = false; return; }

    const heading  = document.querySelector('h1, .itemName, [class*="itemName"]');
    const itemName = heading?.textContent?.trim() ?? '';
    pendingData = { lbData, itemName };
    log.info('Fetch done, attempting injection');
    tryInject();
    fetchBusy = false;
  }

  function checkForNewItem() {
    const id = getItemIdFromUrl();
    if (id && id !== lastItemId) {
      log.info(`New item: ${id} (was: ${lastItemId})`);
      lastItemId     = id;
      pendingData    = null;
      fetchBusy      = false;
      currentFetchId = null;  // invalidates any in-flight fetch
      onNewItem(id);
    }
  }

  const observer = new MutationObserver(() => {
    if (location.href !== lastHref) {
      lastHref = location.href;
      log.info('URL changed:', location.href);
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(checkForNewItem, 800);
    }
    if (pendingData) tryInject();
  });
  observer.observe(document.body, { childList: true, subtree: true });

  window.addEventListener('hashchange', () => { clearTimeout(debounceTimer); debounceTimer = setTimeout(checkForNewItem, 800); });
  window.addEventListener('popstate',   () => { clearTimeout(debounceTimer); debounceTimer = setTimeout(checkForNewItem, 800); });

  log.info('Letterboxd ratings in Jellyfin loaded');
  setTimeout(checkForNewItem, 1500);

})();
