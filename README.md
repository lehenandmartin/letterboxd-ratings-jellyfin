# Letterboxd ratings in Jellyfin

A lightweight userscript that adds Letterboxd ratings directly to your Jellyfin movie pages — no API required.

<img width="767" height="97" alt="Letterboxd ratings in Jellyfin" src="https://github.com/user-attachments/assets/630ab9f3-7d10-472f-9050-5f4f44557842" />

## What it does

On any movie detail page in your Jellyfin instance, the script:

* **Adds a rating chip** to the media info row
* **Adds a Letterboxd link** to the external links section (alongside IMDb, TMDB, etc.)

Hovering the chip reveals the full precision score and number of ratings:

```
Letterboxd: 3.67/5 — 142,314 ratings
```

All requests to Letterboxd are performed client-side via the userscript (bypassing CORS).
No external service or API key is required.
## Scope

This script is a **read-only rating display tool**. It:

* fetches the public Letterboxd rating for a film
* displays it inside Jellyfin

It does **not**:

* require a Letterboxd account
* connect to any account
* sync watch history or ratings
## Installation

### Prerequisites

Install a userscript manager:

* [Tampermonkey](https://www.tampermonkey.net/) — Chrome, Firefox, Edge, Safari
* [Violentmonkey](https://violentmonkey.github.io/) — Chrome, Firefox, Edge
### Install the script

1. Click the extension icon → **Create new script**
2. Delete the default template
3. Paste the contents of [`letterboxd-ratings-jellyfin.user.js`](./letterboxd-ratings-jellyfin.user.js)
4. Edit the `@match` line to target your Jellyfin instance:

```
 // @match  https://jellyfin.example.com/*
```

5. Save

Navigate to any movie page — the Letterboxd rating should appear within seconds.
## Configuration

All options are defined at the top of the script under `// ── User config ──`.

### `@match` — target Jellyfin instance

You can add multiple instances:

```js
// @match  https://jellyfin.example.com/*
// @match  http://192.168.1.10:8096/*
```
### `DEBUG` — console logging

```js
const DEBUG = false;
```

Set to `true` to enable verbose logs (filter `[LB]` in DevTools).
Errors are always logged.
### `CACHE_TTL_MS` — cache duration

```js
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
```

Determines how long cached ratings are reused before re-fetching.

Cached data is persisted via the userscript storage, so revisiting a movie avoids additional requests until expiration.
## Notes

* Letterboxd has no public API — the script parses structured metadata (`<meta itemprop="ratingValue">`) from the film page HTML
* This may break if Letterboxd significantly changes its markup
* This project is not affiliated with Letterboxd or Jellyfin
## Authorship

This userscript was primarily written with [Claude AI](https://claude.ai), supervised and refined by the project author.
## License

MIT
