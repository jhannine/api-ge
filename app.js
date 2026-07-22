
// AniVibe Unified Controller
//
// [DONE — fixed in this pass]
//   - Genre/format now sent to AniList itself (GRAPHQL_QUERY + fetchAnime) and
//     refetched on change, instead of only filtering the current page client-side.
//   - Sort dropdown wired up (#sort-filter -> state.sortBy -> GRAPHQL_QUERY $sort).
//   - Watchlist entries now cache {title, cover} (buildWatchlistEntry) so items
//     still render correctly in the watchlist modal after scrolling off page.
//   - openModal() guards against null anime.popularity before toLocaleString().
//   - Card title/studio interpolations now escaped via escapeHtml() before
//     going into innerHTML.
//   - Node static file server normalizes the resolved path and rejects anything
//     that escapes __dirname (path traversal guard).
//   - fetchAnime() now checks for HTTP 429 and auto-retries after Retry-After.
//   - Added: clear (×) button in the search input; quick-add-to-watchlist heart
//     directly on each grid card; total result count shown in the results bar.
//
// TODO / still open:
// [Bugs]
//   - fetchAnime() still has no request-ordering guard (no AbortController/
//     request id), so a very fast search/page/filter change in a row can let
//     an older response overwrite a newer one.
// [Accessibility]
//   - Modals lack role="dialog"/aria-modal and a focus trap.
//   - Star rating icons (<i>) aren't keyboard-reachable; should be real buttons
//     with aria-labels.
// [Features to consider]
//   - "Back to top" button after paging through a long results grid.
//   - Watchlist status beyond a single list: separate CURRENT / COMPLETED /
//     PLAN_TO_WATCH / DROPPED buckets in the watchlist modal (the data model
//     already stores a `status` field per entry but the UI never uses it).
//   - Recently viewed / search history (localStorage), shown as quick-pick chips
//     under the search bar.
//   - Export/import watchlist as JSON, since it's localStorage-only and tied to
//     one browser/device.
//   - Related/recommended anime section in the detail modal (AniList's `Media`
//     query supports `recommendations`).
//   - Adult content toggle (AniList's `isAdult` field + `Page(..., isAdult: false)`
//     filtering) since the current query doesn't exclude or flag it.
//   - Year/season filter (AniList `seasonYear`/`season` args) alongside the
//     existing genre/format/sort dropdowns.
//   - Character list + voice actors in the detail modal (`Media.characters`).
//   - Infinite scroll as an alternative/toggle to numbered pagination.
//   - Keyboard shortcut ("/" to focus search, Esc already closes modals).
//   - Share button on the detail modal that copies a deep link
//     (e.g. ?anime=12345) so a specific title can be linked directly; would need
//     a small router to read the query param on load and auto-open that modal.
//   - Light theme toggle, since the design system is currently dark-only.
//   - Toast/snackbar confirmation ("Added to watchlist") instead of the silent
//     heart-icon-only feedback, for clearer state changes.
//
if (typeof window === 'undefined') {
  // Node.js Backend Server (Port 8080)
  const http = require('http');
  const https = require('https');
  const fs = require('fs');
  const path = require('path');

  const PORT = 8080;

  const MIME_TYPES = {
    '.html': 'text/html',
    '.css': 'text/css',
    '.js': 'text/javascript',
    '.json': 'application/json',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon'
  };

  http.createServer((req, res) => {
    // CORS headers for API requests
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Accept');

    if (req.method === 'OPTIONS') {
      res.writeHead(200);
      res.end();
      return;
    }

    // Proxy AniList token exchange (POST /api/token)
    if (req.method === 'POST' && req.url === '/api/token') {
      const targetUrl = 'https://anilist.co/api/v2/oauth/token';
      let body = '';
      req.on('data', chunk => {
        body += chunk;
      });

      req.on('end', () => {
        const apiReq = https.request(targetUrl, {
          method: 'POST',
          headers: {
            'Content-Type': req.headers['content-type'] || 'application/x-www-form-urlencoded',
            'Accept': 'application/json'
          }
        }, apiRes => {
          res.writeHead(apiRes.statusCode, { 'Content-Type': 'application/json' });
          apiRes.pipe(res);
        });

        apiReq.on('error', err => {
          console.error('Proxy request error:', err);
          res.writeHead(500);
          res.end(JSON.stringify({ error: err.message }));
        });

        apiReq.write(body);
        apiReq.end();
      });
      return;
    }

    // Serve static files
    if (req.method === 'GET') {
      let urlPath = req.url.split('?')[0];
      if (urlPath === '/') urlPath = '/index.html';

      // Normalize away ../ segments and confirm the resolved path is still
      // inside __dirname before touching the filesystem (path traversal guard).
      const safeSuffix = path.normalize(urlPath).replace(/^(\.\.[/\\])+/, '');
      const filePath = path.join(__dirname, safeSuffix);
      if (!filePath.startsWith(path.normalize(__dirname))) {
        res.writeHead(403, { 'Content-Type': 'text/html' });
        res.end('<h1>403 Forbidden</h1>', 'utf-8');
        return;
      }

      const extname = String(path.extname(filePath)).toLowerCase();
      const contentType = MIME_TYPES[extname] || 'application/octet-stream';

      fs.readFile(filePath, (error, content) => {
        if (error) {
          if (error.code === 'ENOENT') {
            res.writeHead(404, { 'Content-Type': 'text/html' });
            res.end('<h1>404 Not Found</h1>', 'utf-8');
          } else {
            res.writeHead(500);
            res.end(`Server Error: ${error.code}`);
          }
        } else {
          res.writeHead(200, { 'Content-Type': contentType });
          res.end(content, 'utf-8');
        }
      });
    }
  }).listen(PORT, () => {
    console.log(`\n🚀 AniVibe Unified Server running at http://localhost:${PORT}\n`);
  });

} else {

  // Browser Client Application
  const ANILIST_API_URL = 'https://graphql.anilist.co';
  const ITEMS_PER_PAGE = 15;

  // Global State
  const state = {
    searchQuery: '',
    currentPage: 1,
    selectedGenre: '',
    selectedFormat: '',
    sortBy: 'POPULARITY_DESC',
    animeList: [],
    pageInfo: {},
    loading: false,
    error: null,
    activeAnimeLibraryEntry: null
  };

  // Guest Watchlist Helpers (localStorage-based, no login required)
 function getRecentViewed(){

try{

return JSON.parse(localStorage.getItem("recent_viewed")||"[]");

}catch{

return[];

}

}

function saveRecentViewed(id){

let list=getRecentViewed();

list=list.filter(x=>x!==id);

list.unshift(id);

list=list.slice(0,10);

localStorage.setItem(
"recent_viewed",
JSON.stringify(list)
);

}
  function getGuestWatchlist() {
    try { return JSON.parse(localStorage.getItem('guest_watchlist') || '[]'); }
    catch { return []; }
  }
  function saveGuestWatchlist(list) {
    localStorage.setItem('guest_watchlist', JSON.stringify(list));
  }
  function getGuestEntry(mediaId) {
    return getGuestWatchlist().find(e => e.mediaId === mediaId) || null;
  }

  // GraphQL query to search anime list
  const GRAPHQL_QUERY = `
  query ($search: String, $page: Int, $perPage: Int, $genre: String, $format: MediaFormat, $sort: [MediaSort]) {
    Page(page: $page, perPage: $perPage) {
      pageInfo {
        total
        currentPage
        lastPage
        hasNextPage
      }
      media(search: $search, type: ANIME, genre: $genre, format: $format, sort: $sort) {
        id
        title {
          english
          romaji
          native
        }
        coverImage {
          extraLarge
          large
          color
        }
        bannerImage
        description(asHtml: false)
        format
        status
        episodes
        duration
        season
        seasonYear
        genres
        averageScore
        popularity
        studios(isMain: true) {
          nodes {
            name
          }
        }
        trailer {
          id
          site
        }
      }
    }
  }
  `;

  // Convert hex color to RGB format
  function hexToRgb(hex) {
    if (!hex) return '59, 130, 246';
    hex = hex.replace('#', '');
    if (hex.length === 3) {
      hex = hex.split('').map(char => char + char).join('');
    }
    const r = parseInt(hex.substring(0, 2), 16);
    const g = parseInt(hex.substring(2, 4), 16);
    const b = parseInt(hex.substring(4, 6), 16);
    return isNaN(r) || isNaN(g) || isNaN(b) ? '59, 130, 246' : `${r}, ${g}, ${b}`;
  }

  // Escape untrusted text before interpolating into innerHTML template strings.
  // AniList titles/studio names are community-editable, so treat them as untrusted.
  function escapeHtml(str) {
    if (str === null || str === undefined) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // Build a watchlist entry, caching title/cover so items removed from
  // state.animeList (e.g. off the current page) still render correctly
  // in the watchlist modal.
  function buildWatchlistEntry(anime, overrides = {}) {
    return {
      mediaId: anime.id,
      status: 'CURRENT',
      score: 0,
      title: anime.title.english || anime.title.romaji || anime.title.native,
      cover: anime.coverImage.large || anime.coverImage.extraLarge || '',
      ...overrides
    };
  }

  // Query AniList directory search
  async function fetchAnime() {
    state.loading = true;
    state.error = null;
    renderState();

    const variables = {
      page: state.currentPage,
      perPage: ITEMS_PER_PAGE,
      sort: [state.sortBy || 'POPULARITY_DESC']
    };

    if (state.searchQuery.trim() !== '') {
      variables.search = state.searchQuery.trim();
    }
    if (state.selectedGenre) {
      variables.genre = state.selectedGenre;
    }
    if (state.selectedFormat) {
      variables.format = state.selectedFormat;
    }

    try {
      const response = await fetch(ANILIST_API_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        },
        body: JSON.stringify({
          query: GRAPHQL_QUERY,
          variables: variables
        })
      });

      // AniList enforces a per-IP rate limit and responds with 429 + a
      // Retry-After header when exceeded. Wait it out and retry once
      // automatically instead of surfacing a generic connection error.
      if (response.status === 429) {
        const retryAfter = parseInt(response.headers.get('Retry-After') || '5', 10);
        const resultsCount = document.getElementById('results-count');
        if (resultsCount) resultsCount.innerHTML = `Rate limited by AniList — retrying in ${retryAfter}s...`;
        await new Promise(resolve => setTimeout(resolve, retryAfter * 1000));
        return fetchAnime();
      }

      let result;
      try {
        result = await response.json();
      } catch {
        throw new Error('Received an invalid response from AniList.');
      }

      if (response.ok && result.data && result.data.Page) {
        state.animeList = result.data.Page.media || [];
        state.pageInfo = result.data.Page.pageInfo || {};
      } else {
        throw new Error(result.errors ? result.errors[0].message : 'Failed to fetch data');
      }
    } catch (err) {
      console.error('API Error:', err);
      state.error = err.message || 'Something went wrong.';
    } finally {
      state.loading = false;
      renderState();
    }
  }

  // Render search results, pagination, filters, and loading grids
  function renderState() {
    const gridContainer = document.getElementById('anime-grid');
    const errorContainer = document.getElementById('error-container');
    const emptyContainer = document.getElementById('empty-container');
    const paginationContainer = document.getElementById('pagination-container');
    const resultsCount = document.getElementById('results-count');

    errorContainer.style.display = 'none';
    emptyContainer.style.display = 'none';
    gridContainer.style.display = 'grid';

    if (state.loading) {
      gridContainer.innerHTML = Array(ITEMS_PER_PAGE).fill(0).map(() => getSkeletonHtml()).join('');
      paginationContainer.innerHTML = '';
      resultsCount.innerHTML = 'Searching the anime universe...';
      return;
    }

    if (state.error) {
      gridContainer.style.display = 'none';
      errorContainer.style.display = 'block';
      document.getElementById('error-message').textContent = state.error;
      resultsCount.innerHTML = 'Error encountered';
      paginationContainer.innerHTML = '';
      return;
    }

    // Genre/format filters are now sent to the AniList API itself (see
    // fetchAnime), so state.animeList already reflects the active filters
    // across the whole catalog, not just the current page.
    const items = state.animeList;

    if (items.length === 0) {
      gridContainer.style.display = 'none';
      emptyContainer.style.display = 'block';
      resultsCount.innerHTML = 'No items found';
      paginationContainer.innerHTML = '';
      return;
    }

    const totalStr = state.pageInfo && state.pageInfo.total ? state.pageInfo.total.toLocaleString() : items.length;
    resultsCount.innerHTML = `Showing <span>${items.length}</span> of <span>${totalStr}</span> anime — page <span>${state.currentPage}</span>`;
    gridContainer.innerHTML = items.map(anime => getAnimeCardHtml(anime)).join('');
    
    document.querySelectorAll('.anime-card').forEach(card => {
      card.addEventListener('click', () => {
        const animeId = parseInt(card.getAttribute('data-id'));
        const anime = state.animeList.find(a => a.id === animeId);
        if (anime) openModal(anime);
      });
    });


    renderRecentViewed();

    // Quick watchlist toggle straight from the grid, without opening the modal
    document.querySelectorAll('.card-quick-heart').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const animeId = parseInt(btn.getAttribute('data-id'));
        const anime = state.animeList.find(a => a.id === animeId);
        if (anime) toggleWatchlist(anime);
      });
    });

    renderPagination();
  }

  // Get anime card markup
  function getAnimeCardHtml(anime) {
    const title = escapeHtml(anime.title.english || anime.title.romaji || anime.title.native);
    const rating = anime.averageScore ? `${anime.averageScore}%` : 'N/A';
    const format = anime.format ? anime.format.replace('_', ' ') : 'UNKNOWN';
    const studio = escapeHtml(
      anime.studios && anime.studios.nodes && anime.studios.nodes.length > 0
        ? anime.studios.nodes[0].name
        : 'Unknown Studio'
    );
    const episodesStr = anime.episodes ? `${anime.episodes} Ep` : 'Ongoing';
    const themeColor = anime.coverImage.color || '#3b82f6';
    const themeColorRgb = hexToRgb(themeColor);
    const inWatchlist = !!getGuestEntry(anime.id);

    return `
      <div class="anime-card" data-id="${anime.id}" style="--card-theme-color: ${themeColor}; --card-theme-color-rgb: ${themeColorRgb};">
        <div class="anime-card-cover">
          <span class="card-badge-rating">
            <i class="fa-solid fa-star"></i> ${rating}
          </span>
          <span class="card-badge-format">${format}</span>
          <button type="button" class="card-quick-heart${inWatchlist ? ' active' : ''}" data-id="${anime.id}" title="${inWatchlist ? 'Remove from Watchlist' : 'Add to Watchlist'}">
            <i class="fa-${inWatchlist ? 'solid' : 'regular'} fa-heart"></i>
          </button>
          <img src="${anime.coverImage.extraLarge || anime.coverImage.large}" alt="${title}" loading="lazy">
        </div>
        <div class="anime-card-content">
          <h3 class="anime-card-title">${title}</h3>
          <div class="anime-card-meta">
            <span class="anime-card-studio">${studio}</span>
            <span>${episodesStr}</span>
          </div>
        </div>
      </div>
    `;
  }

  // Get loader shimmer card markup
  function getSkeletonHtml() {
    return `
      <div class="anime-card skeleton-card">
        <div class="skeleton-shimmer skeleton-image"></div>
        <div class="anime-card-content">
          <div class="skeleton-shimmer skeleton-text-title"></div>
          <div class="skeleton-shimmer skeleton-text-subtitle"></div>
        </div>
      </div>
    `;
  }

  // Render pagination buttons
  function renderPagination() {
    const pag = state.pageInfo;
    const container = document.getElementById('pagination-container');
    if (!pag || pag.lastPage <= 1) {
      container.innerHTML = '';
      return;
    }

    let html = '';
    html += `
      <button class="pag-btn" ${state.currentPage === 1 ? 'disabled' : ''} onclick="changePage(${state.currentPage - 1})">
        <i class="fa-solid fa-chevron-left"></i>
      </button>
    `;

    html += `
      <button class="pag-btn ${state.currentPage === 1 ? 'active' : ''}" onclick="changePage(1)">1</button>
    `;

    if (state.currentPage > 3) {
      html += `<span class="pag-ellipsis">...</span>`;
    }

    const startPage = Math.max(2, state.currentPage - 1);
    const endPage = Math.min(pag.lastPage - 1, state.currentPage + 1);

    for (let i = startPage; i <= endPage; i++) {
      html += `
        <button class="pag-btn ${state.currentPage === i ? 'active' : ''}" onclick="changePage(${i})">${i}</button>
      `;
    }

    if (state.currentPage < pag.lastPage - 2) {
      html += `<span class="pag-ellipsis">...</span>`;
    }

    if (pag.lastPage > 1) {
      html += `
        <button class="pag-btn ${state.currentPage === pag.lastPage ? 'active' : ''}" onclick="changePage(${pag.lastPage})">${pag.lastPage}</button>
      `;
    }

    html += `
      <button class="pag-btn" ${!pag.hasNextPage ? 'disabled' : ''} onclick="changePage(${state.currentPage + 1})">
        <i class="fa-solid fa-chevron-right"></i>
      </button>
    `;

    container.innerHTML = html;
  }

  // Navigate pagination pages
  window.changePage = function(pageNumber) {
    if (pageNumber < 1 || (state.pageInfo && pageNumber > state.pageInfo.lastPage)) return;
    state.currentPage = pageNumber;
    fetchAnime();
    document.getElementById('filter-panel').scrollIntoView({ behavior: 'smooth' });
  };

  // Open modal details page

  async function openModal(anime) {
    saveRecentViewed(anime.id);
    const modal = document.getElementById('details-modal');
    const themeColor = anime.coverImage.color || '#3b82f6';
    const themeColorRgb = hexToRgb(themeColor);

    modal.style.setProperty('--modal-theme-color', themeColor);
    modal.style.setProperty('--modal-theme-color-rgb', themeColorRgb);

    const bannerImg = document.getElementById('modal-banner-img');
    if (anime.bannerImage) {
      bannerImg.style.display = 'block';
      bannerImg.src = anime.bannerImage;
    } else {
      bannerImg.style.display = 'none';
      document.querySelector('.modal-banner').style.background = `linear-gradient(135deg, rgba(${themeColorRgb}, 0.2), rgba(18,18,20,1))`;
    }

    document.getElementById('modal-cover-img').src = anime.coverImage.extraLarge || anime.coverImage.large;
    document.getElementById('modal-title-main').textContent = anime.title.english || anime.title.romaji;
    document.getElementById('modal-title-alt').textContent = anime.title.native || anime.title.romaji || '';

    document.getElementById('modal-stat-score').textContent = anime.averageScore ? `${anime.averageScore}%` : 'N/A';
    document.getElementById('modal-stat-pop').textContent = anime.popularity != null ? anime.popularity.toLocaleString() : 'N/A';
    
    document.getElementById('modal-info-format').textContent = anime.format ? anime.format.replace('_', ' ') : 'N/A';
    document.getElementById('modal-info-episodes').textContent = anime.episodes || 'Ongoing';
    document.getElementById('modal-info-duration').textContent = anime.duration ? `${anime.duration} mins` : 'N/A';
    document.getElementById('modal-info-status').textContent = anime.status ? anime.status.replace('_', ' ') : 'N/A';
    
    const studio = anime.studios && anime.studios.nodes && anime.studios.nodes.length > 0 ? anime.studios.nodes[0].name : 'N/A';
    document.getElementById('modal-info-studio').textContent = studio;
    
    const seasonYear = anime.season && anime.seasonYear ? `${anime.season} ${anime.seasonYear}` : anime.seasonYear || 'N/A';
    document.getElementById('modal-info-release').textContent = seasonYear;

    const genreContainer = document.getElementById('modal-genres');
    genreContainer.innerHTML = anime.genres && anime.genres.length > 0 
      ? anime.genres.map(genre => `<span class="genre-tag">${genre}</span>`).join('')
      : '<span class="text-muted">No genres listed</span>';

    let cleanDesc = anime.description || 'No description available.';
    cleanDesc = cleanDesc.replace(/<br\s*\/?>/gi, '\n');
    document.getElementById('modal-description').textContent = cleanDesc;

    const trailerSection = document.getElementById('modal-trailer-section');
    const trailerIframe = document.getElementById('modal-trailer-iframe');
    if (anime.trailer && anime.trailer.id && anime.trailer.site === 'youtube') {
      trailerSection.style.display = 'block';
      trailerIframe.src = `https://www.youtube.com/embed/${anime.trailer.id}?enablejsapi=1&origin=${window.location.origin}`;
    } else {
      trailerSection.style.display = 'none';
      trailerIframe.src = '';
    }

    renderModalLibrarySection(anime);

    modal.classList.add('active');
    document.body.style.overflow = 'hidden';
  }

  // Close modal details page
  function closeModal() {
    const modal = document.getElementById('details-modal');
    modal.classList.remove('active');
    document.body.style.overflow = '';
    document.getElementById('modal-trailer-iframe').src = '';
  }

  // Render watchlist heart status and rating stars
  async function renderModalLibrarySection(anime) {
    const favBtn = document.getElementById('favorite-toggle-btn');
    const ratingContainer = document.getElementById('modal-rating-container');
    const starsContainer = document.getElementById('rating-stars');

    if (!favBtn) return;

    // Reset heart/stars to default
    favBtn.classList.remove('active');
    favBtn.innerHTML = `<i class="fa-regular fa-heart"></i>`;
    favBtn.title = "Add to Watchlist";
    if (ratingContainer) ratingContainer.style.display = 'flex';
    updateStarsUI(0);

    state.activeAnimeLibraryEntry = { id: null, status: 'REMOVE', score: 0 };

    if (!anime) return;

    // Load from localStorage
    const savedEntry = getGuestEntry(anime.id);
    if (savedEntry) {
      state.activeAnimeLibraryEntry = { id: anime.id, status: 'CURRENT', score: savedEntry.score || 0 };
      updateHeartUI(true);
      updateStarsUI(savedEntry.score || 0);
    }

    // Bind heart button
    const cleanFavBtn = favBtn.cloneNode(true);
    favBtn.replaceWith(cleanFavBtn);
    cleanFavBtn.addEventListener('click', () => toggleWatchlist(anime));

    // Bind Stars Hover and Click handlers
    if (starsContainer) {
      const cleanStarsContainer = starsContainer.cloneNode(true);
      starsContainer.replaceWith(cleanStarsContainer);
      const newStars = cleanStarsContainer.querySelectorAll('i');
      newStars.forEach(star => {
        star.addEventListener('mouseenter', (e) => {
          const val = parseInt(e.target.getAttribute('data-value'));
          newStars.forEach((s, idx) => {
            s.className = idx + 1 <= val ? 'fa-solid fa-star hover' : 'fa-regular fa-star';
          });
        });
        star.addEventListener('mouseleave', () => {
          updateStarsUI(state.activeAnimeLibraryEntry ? state.activeAnimeLibraryEntry.score : 0);
        });
        star.addEventListener('click', (e) => {
          const val = parseInt(e.target.getAttribute('data-value'));
          saveRating(anime, val * 20);
        });
      });
    }
  }

  // Update watchlist heart icon state
  function updateHeartUI(isInList) {
    const favBtn = document.getElementById('favorite-toggle-btn');
    if (!favBtn) return;
    
    if (isInList) {
      favBtn.classList.add('active');
      favBtn.innerHTML = `<i class="fa-solid fa-heart"></i>`;
      favBtn.title = "Remove from Watchlist";
    } else {
      favBtn.classList.remove('active');
      favBtn.innerHTML = `<i class="fa-regular fa-heart"></i>`;
      favBtn.title = "Add to Watchlist";
    }
  }

  // Update rating stars icons state
  function updateStarsUI(score) {
    const starsContainer = document.getElementById('rating-stars');
    if (!starsContainer) return;
    
    const stars = starsContainer.querySelectorAll('i');
    const ratingValue = score ? Math.round(score / 20) : 0;
    
    stars.forEach((star, idx) => {
      const val = idx + 1;
      if (val <= ratingValue) {
        star.className = 'fa-solid fa-star active';
      } else {
        star.className = 'fa-regular fa-star';
      }
    });
  }

  // Add/remove anime from watchlist (localStorage). Accepts the full anime
  // object (not just its id) so title/cover can be cached in the entry —
  // needed so the watchlist modal can render it even after it scrolls off
  // the currently loaded page (see renderWatchlistModal).
  async function toggleWatchlist(anime) {
    const mediaId = anime.id;
    const list = getGuestWatchlist();
    const alreadyIn = list.some(e => e.mediaId === mediaId);

    if (alreadyIn) {
      saveGuestWatchlist(list.filter(e => e.mediaId !== mediaId));
      state.activeAnimeLibraryEntry = { id: null, status: 'REMOVE', score: 0 };
      updateHeartUI(false);
      updateStarsUI(0);
      updateCardHeartUI(mediaId, false);
    } else {
      list.push(buildWatchlistEntry(anime));
      saveGuestWatchlist(list);
      state.activeAnimeLibraryEntry = { id: mediaId, status: 'CURRENT', score: 0 };
      updateHeartUI(true);
      updateCardHeartUI(mediaId, true);
    }
    updateWatchlistBadge();
  }

  // Save score rating (localStorage). Accepts the full anime object for the
  // same caching reason as toggleWatchlist above.
  function saveRating(anime, scoreValue) {
    const mediaId = anime.id;
    const list = getGuestWatchlist();
    const existing = list.find(e => e.mediaId === mediaId);
    if (existing) {
      existing.score = scoreValue;
    } else {
      list.push(buildWatchlistEntry(anime, { score: scoreValue }));
    }
    saveGuestWatchlist(list);
    state.activeAnimeLibraryEntry = { id: mediaId, status: 'CURRENT', score: scoreValue };
    updateHeartUI(true);
    updateStarsUI(scoreValue);
    updateCardHeartUI(mediaId, true);
    updateWatchlistBadge();
  }

  // Sync a card's quick-heart icon in the currently rendered grid, if present
  function updateCardHeartUI(mediaId, isInList) {
    const btn = document.querySelector(`.card-quick-heart[data-id="${mediaId}"]`);
    if (!btn) return;
    btn.classList.toggle('active', isInList);
    btn.innerHTML = isInList ? '<i class="fa-solid fa-heart"></i>' : '<i class="fa-regular fa-heart"></i>';
    btn.title = isInList ? 'Remove from Watchlist' : 'Add to Watchlist';
  }

  // Debounce search function
  function debounce(func, wait) {
    let timeout;
    return function executedFunction(...args) {
      const later = () => {
        clearTimeout(timeout);
        func(...args);
      };
      clearTimeout(timeout);
      timeout = setTimeout(later, wait);
    };
  }

  // Update header watchlist badge count
  function updateWatchlistBadge() {
    const list = getGuestWatchlist();
    const badge = document.getElementById('watchlist-badge');
    if (!badge) return;
    if (list.length > 0) {
      badge.textContent = list.length;
      badge.style.display = 'flex';
    } else {
      badge.style.display = 'none';
    }
  }

  // Render watchlist modal body
  function renderWatchlistModal() {
    const list = getGuestWatchlist();
    const body = document.getElementById('watchlist-modal-body');
    const countEl = document.getElementById('watchlist-modal-count');
    if (!body) return;

    if (countEl) countEl.textContent = `${list.length} anime`;

    if (list.length === 0) {
      body.innerHTML = `
        <div class="watchlist-empty-state">
          <i class="fa-regular fa-bookmark"></i>
          <p>Your watchlist is empty.<br>Click the ❤️ heart on any anime to add it.</p>
        </div>
      `;
      return;
    }

    body.innerHTML = list.map(entry => {
      const anime = state.animeList.find(a => a.id === entry.mediaId);
      const rawTitle = anime
        ? (anime.title.english || anime.title.romaji || anime.title.native)
        : (entry.title || `Anime #${entry.mediaId}`);
      const title = escapeHtml(rawTitle);
      const cover = anime ? (anime.coverImage.large || anime.coverImage.extraLarge) : (entry.cover || '');
      const starCount = entry.score ? Math.round(entry.score / 20) : 0;
      const starsHtml = starCount > 0
        ? Array.from({ length: 5 }, (_, i) =>
            `<i class="fa-${i < starCount ? 'solid' : 'regular'} fa-star"></i>`
          ).join('')
        : `<span class="no-rating">Not rated</span>`;

      return `
        <div class="watchlist-item" data-media-id="${entry.mediaId}">
          ${cover ? `<img class="watchlist-item-cover" src="${cover}" alt="${title}" loading="lazy">` : ''}
          <div class="watchlist-item-info">
            <div class="watchlist-item-title">${title}</div>
            <div class="watchlist-item-rating">${starsHtml}</div>
          </div>
          <button class="watchlist-remove-btn" data-remove-id="${entry.mediaId}" title="Remove from watchlist">
            <i class="fa-solid fa-trash-can"></i>
          </button>
        </div>
      `;
    }).join('');

    // Bind remove buttons
    body.querySelectorAll('.watchlist-remove-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const mediaId = parseInt(btn.getAttribute('data-remove-id'));
        const updated = getGuestWatchlist().filter(e => e.mediaId !== mediaId);
        saveGuestWatchlist(updated);
        updateWatchlistBadge();
        updateCardHeartUI(mediaId, false);
        renderWatchlistModal();
        // If this is the currently open anime, update its heart
        if (state.activeAnimeLibraryEntry && state.activeAnimeLibraryEntry.id === mediaId) {
          state.activeAnimeLibraryEntry = { id: null, status: 'REMOVE', score: 0 };
          updateHeartUI(false);
          updateStarsUI(0);
        }
      });
    });

    // Bind click to open anime modal
    body.querySelectorAll('.watchlist-item').forEach(item => {
      item.addEventListener('click', (e) => {
        if (e.target.closest('.watchlist-remove-btn')) return;
        const mediaId = parseInt(item.getAttribute('data-media-id'));
        const anime = state.animeList.find(a => a.id === mediaId);
        if (anime) {
          closeWatchlistModal();
          openModal(anime);
        }
      });
    });
  }

  // Open watchlist modal
  function openWatchlistModal() {
    renderWatchlistModal();
    const modal = document.getElementById('watchlist-modal');
    if (modal) {
      modal.classList.add('active');
      document.body.style.overflow = 'hidden';
    }
  }

  // Close watchlist modal
  function closeWatchlistModal() {
    const modal = document.getElementById('watchlist-modal');
    if (modal) {
      modal.classList.remove('active');
      document.body.style.overflow = '';
    }
  }

  // DOM Content Loaded initializations
  document.addEventListener('DOMContentLoaded', async () => {

  const themeBtn = document.getElementById('theme-toggle-btn');


  if (themeBtn) {

    const themeIcon = themeBtn.querySelector('i');


    // Load saved theme
    const savedTheme = localStorage.getItem('anivibe-theme');


    if (savedTheme === 'light') {

      document.body.classList.add('light-mode');

      if (themeIcon) {
        themeIcon.className = 'fa-solid fa-sun';
      }

    }



    themeBtn.addEventListener('click', () => {


      document.body.classList.toggle('light-mode');


      const isLight =
        document.body.classList.contains('light-mode');

      // Save preference
      localStorage.setItem(
        'anivibe-theme',
        isLight ? 'light' : 'dark'
      );

      // Change icon
      if (themeIcon) {

        if (isLight) {

          themeIcon.className = 'fa-solid fa-sun';

        } else {

          themeIcon.className = 'fa-solid fa-moon';

        }
      }
    });
  }

    const searchInput = document.getElementById('search-input');
    const searchForm = document.getElementById('search-form');
    const searchClearBtn = document.getElementById('search-clear-btn');
    const genreFilter = document.getElementById('genre-filter');
    const formatFilter = document.getElementById('format-filter');
    const sortFilter = document.getElementById('sort-filter');
    const closeModalBtn = document.getElementById('modal-close-btn');
    const modalBackdrop = document.getElementById('details-modal');
    const retryBtn = document.getElementById('retry-btn');
    const randomBtn = document.getElementById('random-anime-btn');
    const watchlistHeaderBtn = document.getElementById('watchlist-header-btn');
    const watchlistCloseBtn = document.getElementById('watchlist-modal-close-btn');
    const watchlistModalBackdrop = document.getElementById('watchlist-modal');

    updateWatchlistBadge();

    function toggleClearBtn() {
      if (searchClearBtn) searchClearBtn.style.display = searchInput.value ? 'flex' : 'none';
    }

    const handleSearch = debounce(() => {
      state.searchQuery = searchInput.value;
      state.currentPage = 1;
      fetchAnime();
    }, 400);

    searchInput.addEventListener('input', () => {
      toggleClearBtn();
      handleSearch();
    });

    if (searchClearBtn) {
      searchClearBtn.addEventListener('click', () => {
        searchInput.value = '';
        toggleClearBtn();
        state.searchQuery = '';
        state.currentPage = 1;
        fetchAnime();
        searchInput.focus();
      });
    }

    searchForm.addEventListener('submit', (e) => {
      e.preventDefault();
      state.searchQuery = searchInput.value;
      state.currentPage = 1;
      fetchAnime();
    });

    // Genre/format/sort are all sent to the AniList API (see fetchAnime),
    // so changing any of them re-fetches rather than just re-rendering.
    genreFilter.addEventListener('change', (e) => {
      state.selectedGenre = e.target.value;
      state.currentPage = 1;
      fetchAnime();
    });

    formatFilter.addEventListener('change', (e) => {
      state.selectedFormat = e.target.value;
      state.currentPage = 1;
      fetchAnime();
    });

    if (sortFilter) {
      sortFilter.addEventListener('change', (e) => {
        state.sortBy = e.target.value;
        state.currentPage = 1;
        fetchAnime();
      });
    }

    closeModalBtn.addEventListener('click', closeModal);
    modalBackdrop.addEventListener('click', (e) => {
      if (e.target === modalBackdrop) closeModal();
    });

    // Watchlist modal events
    watchlistHeaderBtn.addEventListener('click', openWatchlistModal);
    watchlistCloseBtn.addEventListener('click', closeWatchlistModal);
    watchlistModalBackdrop.addEventListener('click', (e) => {
      if (e.target === watchlistModalBackdrop) closeWatchlistModal();
    });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        if (modalBackdrop.classList.contains('active')) closeModal();
        if (watchlistModalBackdrop.classList.contains('active')) closeWatchlistModal();
      }
    });

    retryBtn.addEventListener('click', () => {
      fetchAnime();
    });
    randomBtn.addEventListener('click', () => {

    if(state.animeList.length===0) return;

    const random =
        state.animeList[
            Math.floor(Math.random()*state.animeList.length)
        ];

    openModal(random);

});

    fetchAnime();
  });
function renderRecentViewed(){

  const bar = document.getElementById("recent-viewed-bar");

  if(!bar) return;

  const ids = getRecentViewed();

  if(ids.length === 0){
    bar.innerHTML = "";
    return;
  }


  bar.innerHTML = `
    <div class="recent-header">
      <strong>Recently Viewed:</strong>
      <button id="clear-recent-btn" class="clear-recent-btn">
        Clear All
      </button>
    </div>
  `;


  ids.forEach(id=>{

    const anime = state.animeList.find(a=>a.id===id);

    if(anime){

      const span=document.createElement("span");

      span.className="recent-chip";

      span.innerText =
        anime.title.english ||
        anime.title.romaji;

      span.onclick=()=>openModal(anime);

      bar.appendChild(span);

    }

  });


  const clearBtn=document.getElementById("clear-recent-btn");

  if(clearBtn){

    clearBtn.onclick=()=>{

      localStorage.removeItem("recent_viewed");

      renderRecentViewed();

    };

  }

}
}
