    var rawData = { movies: [], tvShows: [], movieSuggestions: [], tvSuggestions: [] };
    /* ================================================================
       Configuration: set GAS_URL to your Apps Script web app URL
       (…/macros/s/…/exec). It is not a secret: every request must also
       carry the access code, which is entered once on each device and
       is never stored in this repository.
       ================================================================ */
    var GAS_URL = 'https://pl9999.github.io/media-tracker/';

    var ACCESS_KEY = 'mt_access_code';
    var memoryAccessCode = '';

    function getAccessCode() {
      try { return localStorage.getItem(ACCESS_KEY) || memoryAccessCode; } catch (e) { return memoryAccessCode; }
    }
    function setAccessCode(v) {
      memoryAccessCode = v;
      try { localStorage.setItem(ACCESS_KEY, v); } catch (e) {}
    }
    function clearAccessCode() {
      memoryAccessCode = '';
      try { localStorage.removeItem(ACCESS_KEY); } catch (e) {}
    }

    function gasCall(action, args) {
      return fetch(GAS_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify({ action: action, args: args || [], token: getAccessCode() }),
        credentials: 'omit',
        referrerPolicy: 'no-referrer'
      })
        .then(function(res) { return res.json(); })
        .then(function(j) {
          if (j && j.ok) return j.result;
          var err = new Error((j && j.error) || 'Request failed');
          if (j && j.code === 401) err.unauthorized = true;
          throw err;
        });
    }

    /* Small stand-in for GAS.run: GAS.run.withSuccessHandler(fn).withFailureHandler(fn).apiName(args) */
    var GAS = {
      get run() {
        var onOk = function() {};
        var onFail = function(e) { console.error(e); };
        var proxy = new Proxy({}, {
          get: function(_, name) {
            if (name === 'withSuccessHandler') return function(fn) { onOk = fn; return proxy; };
            if (name === 'withFailureHandler') return function(fn) { onFail = fn; return proxy; };
            return function() {
              var args = Array.prototype.slice.call(arguments);
              gasCall(String(name), args).then(
                function(res) { onOk(res); },
                function(err) {
                  if (err && err.unauthorized) {
                    var had = !!getAccessCode();
                    clearAccessCode();
                    showLogin(had ? 'That access code was not accepted.' : '');
                  }
                  onFail(err);
                }
              );
            };
          }
        });
        return proxy;
      }
    };

    function showLogin(message) {
      var overlay = document.getElementById('loginOverlay');
      overlay.classList.add('show');
      document.getElementById('loginError').textContent = message || '';
      var input = document.getElementById('loginInput');
      input.value = '';
      setTimeout(function() { input.focus(); }, 50);
    }

    function submitLogin() {
      var input = document.getElementById('loginInput');
      var code = input.value.trim();
      if (!code) return;
      setAccessCode(code);
      input.value = '';
      document.getElementById('loginOverlay').classList.remove('show');
      startLoad();
    }

    function lockDevice() {
      clearAccessCode();
      rawData = { movies: [], tvShows: [], movieSuggestions: [], tvSuggestions: [] };
      document.getElementById('mediaGrid').innerHTML = '';
      showLogin('');
    }

    /* image paths coming back from TMDB are only ever used if they look like /abc123.jpg */
    function tmdbImgPath(p) {
      return (typeof p === 'string' && /^\/[A-Za-z0-9_.-]+$/.test(p)) ? p : '';
    }

    var currentCategory = 'tv';
    var currentViewMode = 'list';
    var activeSubMenu = 'main';

    var selectedTvStatuses = {
      'history': false,
      'watch-next': true,
      'dust': false,
      'not-started': false,
      'all-az': false
    };

    var selectedMovieStatuses = {
      'watched': true,
      'watch-next': true
    };

    var selectedMovieSort = 'title-az';
    var selectedGenre = 'all';

    var selectedExplore = { shows: false, movies: false };
    var appSettings = { resumeWeeks: 13 };
    var settingsDirty = false;
    var settingsSaveTimer = null;
    var lastLoadedAt = null;
    var loadProgress = null;

    var activeItemTarget = null;
    var searchDebounce = null;

    var greenCheckSvg = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#34c759" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';
    var greyCircleCheckSvg = '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#48484a" stroke-width="1.8"><circle cx="12" cy="12" r="9.5"/><polyline points="16 9 10.5 14.5 8 12" stroke="#48484a" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';

    function isMobileDevice() {
      return window.innerWidth <= 768;
    }

    window.addEventListener('load', function() { positionNavPill(false); });
    setTimeout(function() { positionNavPill(false); }, 0);

    var lastViewportWidth = window.innerWidth;
    window.addEventListener('resize', function() {
      positionNavPill(false);
      if (window.innerWidth === lastViewportWidth) return;
      lastViewportWidth = window.innerWidth;
      renderCurrentCategoryView();
    });

    /* Apps Script gives no byte-level progress, so the bar eases towards ~92%
       while the request is in flight and jumps to 100% when the data arrives. */
    function startProgress(fillEl) {
      var p = 0;
      fillEl.style.width = '0%';
      var timer = setInterval(function() {
        p += (92 - p) * 0.07;
        fillEl.style.width = p.toFixed(1) + '%';
      }, 250);
      return {
        finish: function(cb) {
          clearInterval(timer);
          fillEl.style.width = '100%';
          setTimeout(function() { if (cb) cb(); }, 380);
        },
        cancel: function() { clearInterval(timer); }
      };
    }

    function startLoad() {
      var loader = document.getElementById('loading');
      loader.style.display = 'block';
      loader.style.color = 'var(--text-sub)';
      document.getElementById('mediaGrid').style.display = 'none';
      loadProgress = startProgress(document.getElementById('loadingFill'));
      GAS.run
        .withSuccessHandler(onDataLoaded)
        .withFailureHandler(onDataError)
        .getWebAppData();
    }

    function onDataError(err) {
      if (loadProgress) { loadProgress.cancel(); loadProgress = null; }
      if (err && err.unauthorized) return; // the access-code prompt is already showing
      var loader = document.getElementById('loading');
      loader.style.color = '#ff3b30';
      loader.innerHTML = 'Failed to load library.<br><br>' + escapeHtml((err && err.message) || err) +
        '<br><br><button class="action-sheet-btn" style="width:auto; background:var(--accent-red); font-weight:600;" data-act="reloadPage">Try again</button>';
    }

    function applyLoadedData(data) {
      rawData = data;
      lastLoadedAt = new Date();
      if (data.settings && !settingsDirty) {
        appSettings.resumeWeeks = data.settings.resumeWeeks || appSettings.resumeWeeks;
      }
    }

    function onDataLoaded(data) {
      applyLoadedData(data);
      if (loadProgress) {
        var lp = loadProgress;
        loadProgress = null;
        lp.finish(showLibrary);
      } else {
        showLibrary();
      }
    }

    function showLibrary() {
      document.getElementById('loading').style.display = 'none';
      document.getElementById('mediaGrid').style.display = 'flex';
      renderCurrentCategoryView();
    }

    function parseTVShowBlocks(tvShows) {
      const blocks = [];
      let currentBlock = null;

      tvShows.forEach((item) => {
        const rawTitle = item.title ? item.title.trim() : '';
        if (!rawTitle) return;

        const isSeasonHeader = /^Season\s+\d+/i.test(rawTitle) || rawTitle.includes('Season');
        const isEpisode = /^S\d+E\d+/i.test(rawTitle);
        const isShowHeader = !isSeasonHeader && !isEpisode;

        if (isShowHeader) {
          currentBlock = { show: item, episodes: [], seasons: [] };
          blocks.push(currentBlock);
        } else if (currentBlock) {
          if (isSeasonHeader) {
            currentBlock.seasons.push(item);
          } else if (isEpisode) {
            const isWatched = item.status === 'TRUE' || item.status === true || String(item.status).toLowerCase() === 'true';
            currentBlock.episodes.push({ item: item, isWatched: isWatched });
          }
        }
      });

      return blocks;
    }

    function formatSeasonEpTag(epTitleStr) {
      if (!epTitleStr) return 'S01E01';
      var match = epTitleStr.match(/S(\d+)E(\d+)/i);
      if (match) {
        var s = parseInt(match[1], 10);
        var e = parseInt(match[2], 10);
        return 'S' + (s < 10 ? '0' + s : s) + ' E' + (e < 10 ? '0' + e : e);
      }
      return epTitleStr;
    }

    function parseDate(dStr) {
      if (!dStr || dStr === 'TBC' || dStr === 'N/A') return 0;
      var str = String(dStr).trim();
      var p = str.split('/');
      if (p.length === 3) {
        var d = parseInt(p[0], 10);
        var m = parseInt(p[1], 10) - 1;
        var y = parseInt(p[2], 10);
        var dt = new Date(y, m, d);
        return isNaN(dt.getTime()) ? 0 : dt.getTime();
      }
      var pDash = str.split('-');
      if (pDash.length === 3) {
        var dtDash = new Date(parseInt(pDash[0], 10), parseInt(pDash[1], 10) - 1, parseInt(pDash[2], 10));
        return isNaN(dtDash.getTime()) ? 0 : dtDash.getTime();
      }
      var parsed = Date.parse(str);
      return isNaN(parsed) ? 0 : parsed;
    }

    /* Treats TBC / N/A release dates as the newest possible date */
    function compareReleaseDates(a, b, ascending) {
      var isTbcA = !a.date || a.date === 'TBC' || a.date === 'N/A';
      var isTbcB = !b.date || b.date === 'TBC' || b.date === 'N/A';

      if (isTbcA && isTbcB) {
        return a.title.localeCompare(b.title, undefined, { sensitivity: 'base', numeric: true });
      }
      if (isTbcA) return ascending ? 1 : -1;
      if (isTbcB) return ascending ? -1 : 1;

      var dateA = parseDate(a.date);
      var dateB = parseDate(b.date);

      if (dateA === dateB) {
        return a.title.localeCompare(b.title, undefined, { sensitivity: 'base', numeric: true });
      }
      return ascending ? (dateA - dateB) : (dateB - dateA);
    }

    function getDaysSinceWatched(dateStr) {
      if (!dateStr || dateStr === 'TBC' || dateStr === 'N/A') return 0;
      var watchTime = parseDate(dateStr);
      if (watchTime > 0) {
        return (new Date().getTime() - watchTime) / (1000 * 60 * 60 * 24);
      }
      return 0;
    }

    function positionNavPill(animate) {
      var pill = document.getElementById('nav-pill');
      var active = document.querySelector('.menu-item.active');
      if (!pill || !active) return;
      if (!animate) pill.classList.add('no-anim');
      pill.style.width = active.offsetWidth + 'px';
      pill.style.transform = 'translateX(' + active.offsetLeft + 'px)';
      if (!animate) {
        void pill.offsetWidth;
        pill.classList.remove('no-anim');
      }
    }

    function updateHeaderForCategory() {
      var h = document.getElementById('stickyHeader');
      if (h) h.style.display = (currentCategory === 'settings') ? 'none' : '';
    }

    function switchMainCategory(cat, el) {
      if (cat === currentCategory && el && el.classList.contains('active')) return;
      currentCategory = cat;

      // 1) the selected item's font turns red straight away
      document.querySelectorAll('.menu-item').forEach(m => m.classList.remove('active'));
      if (el) el.classList.add('active');

      // 2) then the black pill glides across to it
      setTimeout(function() { positionNavPill(true); }, 140);

      selectedGenre = 'all';
      updateHeaderForCategory();
      window.scrollTo(0, 0);
      renderCurrentCategoryView();
    }

    function onSearchInput() {
      clearTimeout(searchDebounce);
      searchDebounce = setTimeout(renderCurrentCategoryView, 200);
    }

    function togglePopoverMenu() {
      var overlay = document.getElementById('popoverOverlay');
      if (overlay.classList.contains('show')) {
        closePopoverMenu();
      } else {
        activeSubMenu = 'main';
        renderPopoverContent();
        overlay.style.display = 'block';
        setTimeout(function() {
          overlay.classList.add('show');
        }, 10);
      }
    }

    function closePopoverMenu() {
      var overlay = document.getElementById('popoverOverlay');
      overlay.classList.remove('show');
      setTimeout(function() {
        overlay.style.display = 'none';
      }, 200);
    }

    function toggleTvStatus(key) {
      if (key === 'all-az') {
        var turnOn = !selectedTvStatuses['all-az'];
        for (var k in selectedTvStatuses) {
          selectedTvStatuses[k] = false;
        }
        selectedTvStatuses['all-az'] = turnOn;
      } else {
        selectedTvStatuses['all-az'] = false;
        selectedTvStatuses[key] = !selectedTvStatuses[key];
      }
      renderPopoverContent();
      renderCurrentCategoryView();
    }

    function renderPopoverContent() {
      var pop = document.getElementById('dropdownPopover');
      pop.innerHTML = '';

      if (activeSubMenu === 'genre') {
        var html = '<div style="display:flex; justify-content:space-between; align-items:center; cursor:pointer;" data-act="subMenu" data-a="main">' +
          '<span style="font-weight:600; font-size:0.95rem;">Genre</span>' +
          '<span style="color:var(--text-sub);">∨</span>' +
          '</div>' +
          '<div class="popover-divider"></div>' +
          '<div class="popover-menu-list" style="max-height:260px; overflow-y:auto;">';

        var genresList = getAllGenres();
        html += '<div class="popover-item" data-act="setGenreFilter" data-a="all"><span>' + (selectedGenre === 'all' ? '✓ ' : '') + 'All genres</span></div>';

        genresList.forEach(function(g) {
          html += '<div class="popover-item" data-act="setGenreFilter" data-a="' + escapeHtml(g) + '"><span>' + (selectedGenre === g ? '✓ ' : '') + escapeHtml(g) + '</span></div>';
        });

        html += '</div>';
        pop.innerHTML = html;
        return;
      }

      var isMobile = isMobileDevice();
      var showViewSelector = !isMobile || currentCategory !== 'tv';

      var viewRowHtml = '';
      if (showViewSelector) {
        viewRowHtml = '<div class="popover-section-label">View</div>' +
          '<div class="popover-view-row">' +
          '<button class="popover-view-btn ' + (currentViewMode === 'list' ? 'active' : '') + '" data-act="setViewMode" data-a="list">' +
          '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>' +
          '</button>' +
          '<button class="popover-view-btn ' + (currentViewMode === 'grid' ? 'active' : '') + '" data-act="setViewMode" data-a="grid">' +
          '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/></svg>' +
          '</button>' +
          '</div>';
      }

      if (currentCategory === 'tv') {
        var tvOptions = [
          { key: 'history', label: 'Watched' },
          { key: 'watch-next', label: 'Watch next' },
          { key: 'dust', label: 'Resume watching' },
          { key: 'not-started', label: 'Not started' }
        ];

        var statusHtml = '<div class="popover-section-label" style="' + (showViewSelector ? 'margin-top:0.4rem;' : '') + '">Status</div>' +
          '<div class="popover-menu-list">';

        tvOptions.forEach(opt => {
          var sel = !!selectedTvStatuses[opt.key];
          statusHtml += '<div class="popover-item ' + (sel ? 'selected' : '') + '" data-act="toggleTvStatus" data-a="' + escapeHtml(opt.key) + '">' +
            '<span>' + escapeHtml(opt.label) + '</span>' +
            '<div class="check-box-icon">✓</div>' +
            '</div>';
        });

        statusHtml += '</div>';

        var allAzHtml = '<div class="popover-divider"></div>' +
          '<div class="popover-section-label">Show List</div>' +
          '<div class="popover-menu-list">' +
          '<div class="popover-item ' + (selectedTvStatuses['all-az'] ? 'selected' : '') + '" data-act="toggleTvStatus" data-a="all-az">' +
          '<span>All shows (A-Z)</span>' +
          '<div class="check-box-icon">✓</div>' +
          '</div>' +
          '</div>';

        var genreItemHtml = '<div class="popover-divider"></div>' +
          '<div class="popover-item" data-act="subMenu" data-a="genre">' +
          '<span>Genre</span><span style="color:var(--text-sub);">›</span>' +
          '</div>';

        pop.innerHTML = viewRowHtml + statusHtml + allAzHtml + genreItemHtml;

      } else if (currentCategory === 'movies') {
        var sortHtml = '<div class="popover-section-label" style="' + (showViewSelector ? 'margin-top:0.4rem;' : '') + '">Sort by</div>' +
          '<div class="popover-menu-list">' +
          '<div class="popover-item" data-act="setMovieSort" data-a="title-az"><span>' + (selectedMovieSort === 'title-az' ? '✓ ' : '') + 'Title, A-Z</span></div>' +
          '<div class="popover-item" data-act="setMovieSort" data-a="release-desc">' +
          '<div class="popover-item-text"><span>' + (selectedMovieSort === 'release-desc' ? '✓ ' : '') + 'Release date</span><span class="popover-item-subtext">Newest first</span></div>' +
          '</div>' +
          '<div class="popover-item" data-act="setMovieSort" data-a="release-asc">' +
          '<div class="popover-item-text"><span>' + (selectedMovieSort === 'release-asc' ? '✓ ' : '') + 'Release date</span><span class="popover-item-subtext">Oldest first</span></div>' +
          '</div>' +
          '<div class="popover-item" data-act="setMovieSort" data-a="watched-asc">' +
          '<div class="popover-item-text"><span>' + (selectedMovieSort === 'watched-asc' ? '✓ ' : '') + 'Watched date</span><span class="popover-item-subtext">Latest last</span></div>' +
          '</div>' +
          '</div>';

        var movieOptions = [
          { key: 'watched', label: 'Watched' },
          { key: 'watch-next', label: 'Unwatched' }
        ];

        var movieStatusHtml = '<div class="popover-section-label" style="margin-top:0.4rem;">Status</div>' +
          '<div class="popover-menu-list">';

        movieOptions.forEach(opt => {
          var sel = !!selectedMovieStatuses[opt.key];
          movieStatusHtml += '<div class="popover-item ' + (sel ? 'selected' : '') + '" data-act="toggleMovieStatus" data-a="' + escapeHtml(opt.key) + '">' +
            '<span>' + escapeHtml(opt.label) + '</span>' +
            '<div class="check-box-icon">✓</div>' +
            '</div>';
        });

        movieStatusHtml += '</div>';

        var genreItemHtml = '<div class="popover-divider"></div>' +
          '<div class="popover-item" data-act="subMenu" data-a="genre">' +
          '<span>Genre</span><span style="color:var(--text-sub);">›</span>' +
          '</div>';

        pop.innerHTML = viewRowHtml + sortHtml + movieStatusHtml + genreItemHtml;
      } else {
        var exploreOptions = [
          { key: 'shows', label: 'Show recommendations' },
          { key: 'movies', label: 'Movie recommendations' }
        ];

        var exploreHtml = '<div class="popover-section-label" style="margin-top:0.4rem;">Recommendations</div>' +
          '<div class="popover-menu-list">';

        exploreOptions.forEach(opt => {
          var sel = !!selectedExplore[opt.key];
          exploreHtml += '<div class="popover-item ' + (sel ? 'selected' : '') + '" data-act="toggleExploreOption" data-a="' + escapeHtml(opt.key) + '">' +
            '<span>' + escapeHtml(opt.label) + '</span>' +
            '<div class="check-box-icon">✓</div>' +
            '</div>';
        });

        exploreHtml += '</div>';

        var exploreGenreHtml = '<div class="popover-divider"></div>' +
          '<div class="popover-item" data-act="subMenu" data-a="genre">' +
          '<span>Genre</span><span style="color:var(--text-sub);">›</span>' +
          '</div>';

        pop.innerHTML = viewRowHtml + exploreHtml + exploreGenreHtml;
      }
    }

    function toggleExploreOption(key) {
      selectedExplore[key] = !selectedExplore[key];
      renderPopoverContent();
      renderCurrentCategoryView();
    }

    function setViewMode(mode) {
      currentViewMode = mode;
      renderPopoverContent();
      renderCurrentCategoryView();
    }

    function toggleMovieStatus(key) {
      selectedMovieStatuses[key] = !selectedMovieStatuses[key];
      renderPopoverContent();
      renderCurrentCategoryView();
    }

    function setMovieSort(sort) {
      selectedMovieSort = sort;
      closePopoverMenu();
      renderCurrentCategoryView();
    }

    function setGenreFilter(g) {
      selectedGenre = g;
      closePopoverMenu();
      renderCurrentCategoryView();
    }

    function getAllGenres() {
      var set = {};
      var all = (currentCategory === 'suggestions')
        ? (rawData.movieSuggestions || []).concat(rawData.tvSuggestions || [])
        : rawData.movies.concat(rawData.tvShows);
      all.forEach(function(i) {
        if (i.genre && i.genre !== 'N/A') {
          i.genre.split(',').forEach(g => { var trimmed = g.trim(); if (trimmed) set[trimmed] = true; });
        }
      });
      return Object.keys(set).sort();
    }

    function renderCurrentCategoryView() {
      var grid = document.getElementById('mediaGrid');
      grid.innerHTML = '';

      var isMobile = isMobileDevice();
      var activeMode = (isMobile && currentCategory === 'tv') ? 'list' : currentViewMode;

      var search = document.getElementById('searchInput').value.toLowerCase().trim();

      if (currentCategory === 'tv') {
        renderTvShowsView(grid, search, activeMode);
      } else if (currentCategory === 'movies') {
        renderMoviesView(grid, search, activeMode);
      } else if (currentCategory === 'settings') {
        renderSettingsView(grid);
      } else {
        renderSuggestionsView(grid, search, activeMode);
      }

      var shouldScrollToBottom = (currentCategory === 'tv' && selectedTvStatuses['history']) ||
                                 (currentCategory === 'movies' && selectedMovieStatuses['watched'] && selectedMovieSort === 'watched-asc');
      if (shouldScrollToBottom) {
        requestAnimationFrame(function() {
          window.scrollTo(0, document.body.scrollHeight);
        });
      }
    }

    function renderTvShowsView(container, search, viewMode) {
      var blocks = parseTVShowBlocks(rawData.tvShows);

      if (search) {
        blocks = blocks.filter(b => b.show.title.toLowerCase().includes(search) || (b.show.genre && b.show.genre.toLowerCase().includes(search)));
      }
      if (selectedGenre !== 'all') {
        blocks = blocks.filter(b => b.show.genre && b.show.genre.includes(selectedGenre));
      }

      var watchNextList = [];
      var dustList = [];
      var notStartedList = [];
      var historyList = [];
      var allAzList = [];

      blocks.forEach(function(b) {
        var totalEps = b.episodes.length;
        var watchedEps = 0;
        var nextEpObj = null;
        var nextEpIndex = -1;
        var lastWatchedEp = null;

        for (var i = 0; i < totalEps; i++) {
          var ep = b.episodes[i];
          if (ep.isWatched) {
            watchedEps++;
            lastWatchedEp = ep;

            historyList.push({
              title: b.show.title,
              nextEpTag: formatSeasonEpTag(ep.item.title),
              nextEpSeqStr: (i + 1) + '/' + totalEps + (ep.item.dateWatched ? ' · ' + ep.item.dateWatched : ''),
              nextEpTitle: ep.item.epTitle || ep.item.title || ('Episode ' + (i + 1)),
              nextEpRowIndex: ep.item.rowIndex,
              rowIndex: ep.item.rowIndex,
              sheetName: 'TV shows',
              isWatched: true,
              tmdbId: b.show.tmdbId,
              dateWatched: ep.item.dateWatched || '',
              isHistoryItem: true
            });
          } else if (!nextEpObj) {
            nextEpObj = ep;
            nextEpIndex = i + 1;
          }
        }

        var showObj = Object.assign({}, b.show);
        showObj.totalEps = totalEps;
        showObj.watchedEps = watchedEps;
        showObj.blockRef = b;
        showObj.isFullyWatched = (watchedEps === totalEps && totalEps > 0);

        if (nextEpObj) {
          showObj.nextEpTag = formatSeasonEpTag(nextEpObj.item.title);
          showObj.nextEpSeqStr = nextEpIndex + '/' + totalEps;
          showObj.nextEpTitle = nextEpObj.item.epTitle || nextEpObj.item.title || ('Episode ' + nextEpIndex);
          showObj.nextEpRowIndex = nextEpObj.item.rowIndex;
        }

        allAzList.push(showObj);

        if (watchedEps === 0) {
          notStartedList.push(showObj);
        } else if (watchedEps < totalEps) {
          var daysSince = lastWatchedEp && lastWatchedEp.item.dateWatched ? getDaysSinceWatched(lastWatchedEp.item.dateWatched) : 0;
          if (daysSince > (appSettings.resumeWeeks * 7)) {
            dustList.push(showObj);
          } else {
            watchNextList.push(showObj);
          }
        }
      });

      historyList.sort(function(a, b) {
        return parseDate(a.dateWatched) - parseDate(b.dateWatched);
      });

      allAzList.sort(function(a, b) {
        return a.title.localeCompare(b.title, undefined, { sensitivity: 'base', numeric: true });
      });

      container.className = viewMode === 'grid' ? 'grid' : 'list-normal';

      if (selectedTvStatuses['history']) {
        renderTvSectionGroup(container, 'Watched', historyList, viewMode, true);
      }
      if (selectedTvStatuses['watch-next']) {
        renderTvSectionGroup(container, 'Watch next', watchNextList, viewMode, false);
      }
      if (selectedTvStatuses['dust']) {
        renderTvSectionGroup(container, 'Resume watching', dustList, viewMode, false);
      }
      if (selectedTvStatuses['not-started']) {
        renderTvSectionGroup(container, 'Not started', notStartedList, viewMode, false);
      }
      if (selectedTvStatuses['all-az']) {
        renderTvSectionGroup(container, 'All shows (A-Z)', allAzList, viewMode, false, true);
      }
    }

    function renderMoviesView(container, search, viewMode) {
      var movies = rawData.movies.slice();

      if (search) {
        movies = movies.filter(m => m.title.toLowerCase().includes(search) || (m.genre && m.genre.toLowerCase().includes(search)));
      }
      if (selectedGenre !== 'all') {
        movies = movies.filter(m => m.genre && m.genre.includes(selectedGenre));
      }

      if (selectedMovieSort === 'title-az') {
        movies.sort((a,b) => a.title.localeCompare(b.title, undefined, { sensitivity: 'base', numeric: true }));
      } else if (selectedMovieSort === 'release-desc') {
        movies.sort((a,b) => compareReleaseDates(a, b, false));
      } else if (selectedMovieSort === 'release-asc') {
        movies.sort((a,b) => compareReleaseDates(a, b, true));
      } else if (selectedMovieSort === 'watched-asc' || selectedMovieSort === 'watched-desc') {
        movies.sort((a,b) => parseDate(a.dateWatched) - parseDate(b.dateWatched));
      }

      var watchedList = movies.filter(m => m.status === 'TRUE' || m.status === true);
      var unwatchedList = movies.filter(m => m.status !== 'TRUE' && m.status !== true);

      container.className = viewMode === 'grid' ? 'grid' : 'list-normal';

      if (selectedMovieStatuses['watched']) {
        renderMovieSectionGroup(container, 'Watched', watchedList, viewMode);
      }
      if (selectedMovieStatuses['watch-next']) {
        renderMovieSectionGroup(container, 'Unwatched', unwatchedList, viewMode);
      }
    }

    function matchesSearchAndGenre(item, search) {
      if (search) {
        var t = (item.title || '').toLowerCase();
        var g = (item.genre || '').toLowerCase();
        if (t.indexOf(search) === -1 && g.indexOf(search) === -1) return false;
      }
      if (selectedGenre !== 'all') {
        if (!item.genre || item.genre.indexOf(selectedGenre) === -1) return false;
      }
      return true;
    }

    function renderSuggestionsView(container, search, viewMode) {
      container.className = viewMode === 'grid' ? 'grid' : 'list-normal';

      if (!selectedExplore.shows && !selectedExplore.movies) {
        container.className = 'list-normal';
        container.innerHTML =
          '<div class="explore-empty">' +
          '<div class="explore-empty-title">Explore recommendations</div>' +
          '<div class="explore-empty-desc">Choose a list to browse, or use the menu button at the top left.</div>' +
          '<div class="explore-empty-actions">' +
          '<button class="action-sheet-btn" style="background:var(--accent-red); font-weight:600;" data-act="toggleExploreOption" data-a="shows">Show recommendations</button>' +
          '<button class="action-sheet-btn" style="background:var(--accent-red); font-weight:600;" data-act="toggleExploreOption" data-a="movies">Movie recommendations</button>' +
          '</div></div>';
        return;
      }

      if (selectedExplore.shows) {
        // The TV suggestions sheet has show header rows followed by season / episode rows; only headers are shown.
        var showRecs = parseTVShowBlocks(rawData.tvSuggestions || [])
          .map(function(b) { return b.show; })
          .filter(function(s) { return matchesSearchAndGenre(s, search); });
        renderRecommendationGroup(container, 'Show recommendations', showRecs, viewMode, 'tv');
      }
      if (selectedExplore.movies) {
        var movieRecs = (rawData.movieSuggestions || [])
          .filter(function(m) { return matchesSearchAndGenre(m, search); });
        renderRecommendationGroup(container, 'Movie recommendations', movieRecs, viewMode, 'movie');
      }
    }

    function renderRecommendationGroup(container, sectionTitle, items, viewMode, typeStr) {
      var header = document.createElement('div');
      header.className = 'section-title';
      header.innerText = sectionTitle;
      container.appendChild(header);

      if (items.length === 0) {
        var emptyMsg = document.createElement('div');
        emptyMsg.style.cssText = 'color: var(--text-sub); font-size: 0.9rem; padding: 0.25rem 0 1.25rem 0; width: 100%;';
        emptyMsg.innerText = 'No recommendations to show';
        container.appendChild(emptyMsg);
        return;
      }

      var targetParent = container;
      if (viewMode === 'grid') {
        targetParent = document.createElement('div');
        targetParent.className = 'grid-section-container';
        container.appendChild(targetParent);
      }

      var isMovie = (typeStr === 'movie');
      var blankPoster = 'data:image/svg+xml;charset=UTF-8,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%22130%22%20height%3D%22195%22%3E%3Crect%20width%3D%22100%25%22%20height%3D%22100%25%22%20fill%3D%22%23242426%22%2F%3E%3C%2Fsvg%3E';

      items.forEach(function(item) {
        var card = document.createElement('div');
        var yr = isMovie ? yearOf(item.date) : '';
        var genreText = (item.genre && item.genre !== 'N/A') ? item.genre : '';

        if (viewMode === 'grid') {
          var gridSub = isMovie ? yr : (genreText ? genreText.split(',')[0].trim() : '');
          card.className = 'bingers-grid-card';
          card.innerHTML = '<img class="grid-poster" src="' + blankPoster + '" alt="">' +
            '<div class="grid-card-title' + (isMovie ? ' title-tight' : '') + '">' + escapeHtml(item.title) + '</div>' +
            '<div class="grid-card-sub">' + escapeHtml(gridSub) + '</div>';
        } else {
          var bits = [];
          if (isMovie) {
            if (yr) bits.push(yr);
            if (item.runtime && item.runtime !== 'N/A') bits.push(item.runtime);
          } else if (genreText) {
            bits.push(genreText);
          }
          if (item.imdbRating && item.imdbRating !== 'TBC') bits.push('IMDb ' + item.imdbRating);
          else if (item.rating && item.rating !== 'TBC') bits.push('TMDB ' + item.rating);

          card.className = 'bingers-list-card';
          card.innerHTML = '<img class="card-poster" src="' + blankPoster + '" alt="">' +
            '<div class="card-info">' +
            '<div class="card-title-text">' + escapeHtml(item.title) + '</div>' +
            '<div class="card-subline">' + escapeHtml(bits.join(' · ')) + '</div>' +
            '<div class="card-synopsis-line">' + escapeHtml(item.synopsis || 'No overview available.') + '</div>' +
            '</div>';
        }

        targetParent.appendChild(card);
        fetchPosterImg(item.tmdbId, typeStr, card.querySelector('img'), item.title);

        card.onclick = function() {
          openMediaDetail({
            title: item.title,
            tmdbId: item.tmdbId,
            type: typeStr,
            date: item.date || '',
            synopsis: item.synopsis || '',
            genre: item.genre || '',
            rating: item.rating || '',
            imdbRating: item.imdbRating || '',
            runtime: item.runtime || ''
          });
        };
      });
    }

    /* ---------- Settings ---------- */
    function weeksLabel(w) { return w + (w === 1 ? ' week' : ' weeks'); }

    function renderSettingsView(container) {
      container.className = 'list-normal';
      container.innerHTML =
        '<div class="section-title">Settings</div>' +

        '<div class="settings-card">' +
          '<div class="settings-row">' +
            '<div class="settings-text">' +
              '<div class="settings-label">Resume watching after</div>' +
              '<div class="settings-desc">A show with unwatched episodes moves to Resume watching when its last watched episode is older than this.</div>' +
            '</div>' +
            '<div class="stepper">' +
              '<button data-act="changeResumeWeeks" data-a="-1" aria-label="Fewer weeks">\u2212</button>' +
              '<span class="stepper-val" id="resumeWeeksVal">' + weeksLabel(appSettings.resumeWeeks) + '</span>' +
              '<button data-act="changeResumeWeeks" data-a="1" aria-label="More weeks">+</button>' +
            '</div>' +
          '</div>' +
        '</div>' +

        '<div class="settings-card">' +
          '<div class="settings-row">' +
            '<div class="settings-text">' +
              '<div class="settings-label">Refresh data</div>' +
              '<div class="settings-desc" id="lastRefreshedText">' + escapeHtml(lastRefreshedText()) + '</div>' +
            '</div>' +
            '<button class="settings-btn" id="refreshBtn" data-act="refreshData">Refresh</button>' +
          '</div>' +
          '<div id="refreshProgressWrap" style="display:none;"><div class="progress-track" style="width:100%; margin:0;"><div class="progress-fill" id="refreshFill"></div></div></div>' +
        '</div>' +

        '<div class="settings-card">' +
          '<div class="settings-row">' +
            '<div class="settings-text">' +
              '<div class="settings-label">Lock this device</div>' +
              '<div class="settings-desc">Forget the access code on this device. You will be asked for it again.</div>' +
            '</div>' +
            '<button class="settings-btn" style="background:#2c2c2e;" data-act="lockDevice">Lock</button>' +
          '</div>' +
        '</div>';
    }

    function lastRefreshedText() {
      if (!lastLoadedAt) return 'Reload your library from Google Sheets.';
      var hh = String(lastLoadedAt.getHours()).padStart(2, '0');
      var mm = String(lastLoadedAt.getMinutes()).padStart(2, '0');
      return 'Reload your library from Google Sheets. Last updated at ' + hh + ':' + mm + '.';
    }

    function changeResumeWeeks(delta) {
      var w = Math.max(1, Math.min(104, appSettings.resumeWeeks + delta));
      if (w === appSettings.resumeWeeks) return;
      appSettings.resumeWeeks = w;
      var v = document.getElementById('resumeWeeksVal');
      if (v) v.textContent = weeksLabel(w);
      settingsDirty = true;
      clearTimeout(settingsSaveTimer);
      settingsSaveTimer = setTimeout(saveSettingsToServer, 500);
    }

    function saveSettingsToServer() {
      GAS.run
        .withSuccessHandler(function(res) {
          settingsDirty = false;
          showToast(res && res.success ? 'Setting saved' : ((res && res.message) || 'Could not save setting'));
        })
        .withFailureHandler(function() {
          settingsDirty = false;
          showToast('Could not save setting');
        })
        .apiSaveSettings({ resumeWeeks: appSettings.resumeWeeks });
    }

    function refreshData() {
      var btn = document.getElementById('refreshBtn');
      var wrap = document.getElementById('refreshProgressWrap');
      var fill = document.getElementById('refreshFill');
      if (!btn || btn.disabled) return;

      btn.disabled = true;
      btn.textContent = 'Refreshing...';
      wrap.style.display = 'block';
      var prog = startProgress(fill);

      GAS.run
        .withSuccessHandler(function(data) {
          prog.finish(function() {
            applyLoadedData(data);
            if (currentCategory === 'settings') renderCurrentCategoryView();
            showToast('Library refreshed');
          });
        })
        .withFailureHandler(function(err) {
          prog.cancel();
          var b = document.getElementById('refreshBtn');
          var w = document.getElementById('refreshProgressWrap');
          if (b) { b.disabled = false; b.textContent = 'Refresh'; }
          if (w) w.style.display = 'none';
          showToast('Refresh failed: ' + ((err && err.message) || err));
        })
        .getWebAppData();
    }

function renderTvSectionGroup(container, sectionTitle, items, viewMode, isHistory, isAllAz) {
  if (items.length === 0) {
    if (sectionTitle === 'Watch next') {
      var header = document.createElement('div');
      header.className = 'section-title';
      header.innerText = sectionTitle;
      container.appendChild(header);

      var emptyMsg = document.createElement('div');
      emptyMsg.style.cssText = 'color: var(--text-sub); font-size: 0.9rem; padding: 0.25rem 0 1.25rem 0; border-bottom: 1px solid var(--border-dark); margin-bottom: 1rem; width: 100%;';
      emptyMsg.innerText = 'All caught up';
      container.appendChild(emptyMsg);
    }
    return;
  }

  var header = document.createElement('div');
  header.className = 'section-title';
  header.innerText = sectionTitle;
  container.appendChild(header);

  var gridSectionContainer = null;
  if (viewMode === 'grid') {
    gridSectionContainer = document.createElement('div');
    gridSectionContainer.className = 'grid-section-container';
    container.appendChild(gridSectionContainer);
  }

  var targetParent = (viewMode === 'grid') ? gridSectionContainer : container;

  items.forEach(function(item) {
    var card;
    if (viewMode === 'grid') {
      card = document.createElement('div');
      card.className = 'bingers-grid-card' + (isHistory ? ' is-history-item' : '');

      var epTagStr = item.nextEpTag || (isAllAz ? (item.watchedEps + '/' + item.totalEps + ' eps') : 'S01E01');
      var epTitleText = item.nextEpTitle ? ' · ' + item.nextEpTitle : '';

      card.innerHTML = '<img class="grid-poster" src="data:image/svg+xml;charset=UTF-8,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%22130%22%20height%3D%22195%22%3E%3Crect%20width%3D%22100%25%22%20height%3D%22100%25%22%20fill%3D%22%23242426%22%2F%3E%3C%2Fsvg%3E" loading="lazy" alt="">' +
        '<div class="grid-card-title">' + escapeHtml(item.title) + '</div>' +
        '<div class="grid-card-sub" title="' + escapeHtml(epTagStr + epTitleText) + '">' + escapeHtml(epTagStr + epTitleText) + '</div>';

      targetParent.appendChild(card);
      fetchPosterImg(item.tmdbId, 'tv', card.querySelector('img'), item.title);

    } else {
      card = document.createElement('div');
      card.className = 'bingers-list-card' + (isHistory ? ' is-history-item' : '');

      var isWatched = isAllAz ? item.isFullyWatched : !!item.isWatched;
      var epTag = item.nextEpTag || (isAllAz ? (item.watchedEps + '/' + item.totalEps + ' watched') : 'S01 E01');
      var seqStr = item.nextEpSeqStr || (item.totalEps ? ('1/' + item.totalEps) : '');
      var epTitleActual = item.nextEpTitle || (isAllAz ? 'Show Details' : 'Episode Details');

      card.innerHTML = '<img class="card-poster" src="data:image/svg+xml;charset=UTF-8,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%2258%22%20height%3D%2287%22%3E%3Crect%20width%3D%22100%25%22%20height%3D%22100%25%22%20fill%3D%22%23242426%22%2F%3E%3C%2Fsvg%3E" loading="lazy" alt="">' +
        '<div class="card-info">' +
        '<div class="card-title-text">' + escapeHtml(item.title) + '</div>' +
        '<div class="card-subline">' + escapeHtml(epTag + (seqStr ? ' · ' + seqStr : '')) + '</div>' +
        '<div class="card-synopsis-line">' + escapeHtml(epTitleActual) + '</div>' +
        '</div>' +
        '<button class="tick-action-btn" data-act="toggleWatchedDirectly" data-a="TV shows" data-b="' + (parseInt(item.nextEpRowIndex || item.rowIndex, 10) || 0) + '" data-c="' + (isWatched ? 'true' : 'false') + '">' +
        (isWatched ? greenCheckSvg : greyCircleCheckSvg) +
        '</button>';

      targetParent.appendChild(card);
      fetchPosterImg(item.tmdbId, 'tv', card.querySelector('img'), item.title);
    }

    card.onclick = function() {
      openMediaDetail({
        title: item.title,
        tmdbId: item.tmdbId,
        type: 'tv',
        synopsis: item.synopsis || '',
        genre: item.genre || '',
        rating: item.rating || '',
        imdbRating: item.imdbRating || ''
      });
    };
  });
}

    function renderMovieSectionGroup(container, sectionTitle, items, viewMode) {
  if (items.length === 0) return;

  var header = document.createElement('div');
  header.className = 'section-title';
  header.innerText = sectionTitle;
  container.appendChild(header);

  var gridSectionContainer = null;
  if (viewMode === 'grid') {
    gridSectionContainer = document.createElement('div');
    gridSectionContainer.className = 'grid-section-container';
    container.appendChild(gridSectionContainer);
  }

  var targetParent = (viewMode === 'grid') ? gridSectionContainer : container;

  items.forEach(function(item) {
    var isWatched = item.status === 'TRUE' || item.status === true;
    var card;

    if (viewMode === 'grid') {
      card = document.createElement('div');
      card.className = 'bingers-grid-card' + (isWatched ? ' is-history-item' : '');

      card.innerHTML = '<img class="grid-poster" src="data:image/svg+xml;charset=UTF-8,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%22130%22%20height%3D%22195%22%3E%3Crect%20width%3D%22100%25%22%20height%3D%22100%25%22%20fill%3D%22%23242426%22%2F%3E%3C%2Fsvg%3E" loading="lazy" alt="">' +
      '<div class="grid-card-title title-tight">' + escapeHtml(item.title) + '</div>' +
      '<div class="grid-card-sub">' + escapeHtml(yearOf(item.date)) + '</div>';

      targetParent.appendChild(card);
      fetchPosterImg(item.tmdbId, 'movie', card.querySelector('img'), item.title);

    } else {
      card = document.createElement('div');
      card.className = 'bingers-list-card' + (isWatched ? ' is-history-item' : '');

      var yearStr = yearOf(item.date);
      var sublineStr = yearStr + (item.runtime && item.runtime !== 'N/A' ? ' · ' + item.runtime : '');

      card.innerHTML = '<img class="card-poster" src="data:image/svg+xml;charset=UTF-8,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%2258%22%20height%3D%2287%22%3E%3Crect%20width%3D%22100%25%22%20height%3D%22100%25%22%20fill%3D%22%23242426%22%2F%3E%3C%2Fsvg%3E" loading="lazy" alt="">' +
      '<div class="card-info">' +
      '<div class="card-title-text">' + escapeHtml(item.title) + '</div>' +
      '<div class="card-subline">' + escapeHtml(sublineStr) + '</div>' +
      '<div class="card-synopsis-line">' + escapeHtml(item.synopsis || 'No overview available.') + '</div>' +
      '</div>' +
      '<button class="tick-action-btn" data-act="toggleWatchedDirectly" data-a="' + escapeHtml(item.sheetName) + '" data-b="' + (parseInt(item.rowIndex, 10) || 0) + '" data-c="' + (isWatched ? 'true' : 'false') + '">' +
      (isWatched ? greenCheckSvg : greyCircleCheckSvg) +
      '</button>';

      targetParent.appendChild(card);
      fetchPosterImg(item.tmdbId, 'movie', card.querySelector('img'), item.title);
    }

    card.onclick = function() {
      openMediaDetail({
        title: item.title,
        tmdbId: item.tmdbId,
        type: item.type || 'movie',
        date: item.date,
        synopsis: item.synopsis || '',
        genre: item.genre || '',
        rating: item.rating || '',
        imdbRating: item.imdbRating || '',
        runtime: item.runtime || ''
      });
    };
  });
}

    function cleanTitleForSearch(raw) {
      if (!raw) return '';
      return raw
        .replace(/\(\d{4}\)/g, '')
        .replace(/Season\s+\d+/gi, '')
        .replace(/S\d+E\d+/gi, '')
        .replace(/[-_]/g, ' ')
        .trim();
    }

    /* Poster loading
       - works on the <img> element itself (no id lookups, so duplicate cards and re-renders are safe)
       - several cards for the same title share one lookup and all get the result
       - lookups go to the backend in batches (the TMDB key never reaches the browser)
       - found posters are remembered on the device, so the next open is instant */
    var POSTER_STORE_KEY = 'mt_posters_v2';
    var POSTER_MISS_TTL = 24 * 60 * 60 * 1000;
    var POSTER_BATCH = 20;
    var POSTER_MAX_PARALLEL = 3;
    var posterStore = {};
    var posterWaiters = {};
    var posterPending = [];
    var posterInFlight = 0;
    var posterFlushTimer = null;
    var posterSaveTimer = null;

    try { posterStore = JSON.parse(localStorage.getItem(POSTER_STORE_KEY) || '{}') || {}; } catch (e) { posterStore = {}; }

    function savePosterStoreSoon() {
      clearTimeout(posterSaveTimer);
      posterSaveTimer = setTimeout(function() {
        try { localStorage.setItem(POSTER_STORE_KEY, JSON.stringify(posterStore)); } catch (e) {}
      }, 1000);
    }

    function fetchPosterImg(tmdbId, type, imgEl, title) {
      if (!imgEl) return;
      if (!getAccessCode()) { setPlaceholderPoster(imgEl, title); return; }

      var cleanTitle = cleanTitleForSearch(title);
      var cleanId = (tmdbId !== null && tmdbId !== undefined) ? tmdbId.toString().replace(/\.0$/, '').trim() : '';
      if (!/^\d{1,10}$/.test(cleanId)) cleanId = '';
      var key = cleanId ? (type + '_' + cleanId) : (type + '_title_' + cleanTitle.toLowerCase());

      var stored = posterStore[key];
      if (stored && (stored.p || (Date.now() - stored.t) < POSTER_MISS_TTL)) {
        applyPoster(imgEl, stored.p, title);
        return;
      }

      if (posterWaiters[key]) { posterWaiters[key].push(imgEl); return; }
      posterWaiters[key] = [imgEl];
      posterPending.push({ key: key, type: type, id: cleanId, title: cleanTitle });

      if (!posterFlushTimer) {
        posterFlushTimer = setTimeout(function() { posterFlushTimer = null; pumpPosterBatches(); }, 60);
      }
    }

    function pumpPosterBatches() {
      while (posterInFlight < POSTER_MAX_PARALLEL && posterPending.length) {
        var batch = [];
        while (batch.length < POSTER_BATCH && posterPending.length) {
          var req = posterPending.shift();
          var waiting = posterWaiters[req.key] || [];
          if (!waiting.some(function(el) { return el.isConnected; })) { delete posterWaiters[req.key]; continue; }
          batch.push(req);
        }
        if (batch.length) sendPosterBatch(batch);
      }
    }

    function sendPosterBatch(batch) {
      posterInFlight++;
      GAS.run
        .withSuccessHandler(function(results) {
          posterInFlight--;
          results = results || [];
          batch.forEach(function(req, i) {
            var r = results[i];
            if (r && r.ok) {
              var p = tmdbImgPath(r.path);
              posterStore[req.key] = { p: p, t: Date.now() };
              finishPoster(req.key, p, req.title);
            } else {
              finishPoster(req.key, null, req.title); // temporary failure: nothing remembered, next render retries
            }
          });
          savePosterStoreSoon();
          pumpPosterBatches();
        })
        .withFailureHandler(function() {
          posterInFlight--;
          batch.forEach(function(req) { finishPoster(req.key, null, req.title); });
          pumpPosterBatches();
        })
        .apiTmdbPosters(batch.map(function(b) { return { type: b.type, id: b.id, title: b.title }; }));
    }

    function finishPoster(key, path, title) {
      var list = posterWaiters[key] || [];
      delete posterWaiters[key];
      list.forEach(function(el) {
        if (path === null) setPlaceholderPoster(el, title);
        else applyPoster(el, path, title);
      });
    }

    function applyPoster(el, path, title) {
      path = tmdbImgPath(path);
      if (!path) { setPlaceholderPoster(el, title); return; }
      el.onerror = function() { el.onerror = null; setPlaceholderPoster(el, title); };
      el.src = 'https://image.tmdb.org/t/p/w342' + path;
    }

    function setPlaceholderPoster(el, titleText) {
      if (!el) return;
      var displayText = titleText ? titleText.replace(/\(\d{4}\)/g, '').trim() : 'No Cover';
      el.onerror = null;
      el.src = 'data:image/svg+xml;charset=UTF-8,' + encodeURIComponent(
        '<svg xmlns="http://www.w3.org/2000/svg" width="130" height="195" viewBox="0 0 130 195"><rect width="100%" height="100%" fill="#242426"/><text x="50%" y="50%" fill="#8e8e93" font-family="-apple-system, sans-serif" font-size="11" font-weight="600" text-anchor="middle" dominant-baseline="middle">' + escapeHtml(displayText).substring(0, 18) + '</text></svg>'
      );
    }

    function openActionSheetForTv(event, showRowIndex, showTitle, isWatched, targetEpRowIndex) {
      event.stopPropagation();
      activeItemTarget = {
        sheetName: 'TV shows',
        showRowIndex: showRowIndex,
        rowIndex: targetEpRowIndex,
        title: showTitle,
        isWatched: isWatched
      };

      document.getElementById('actionSheetTitle').innerText = isWatched ? 'Watched' : showTitle;
      document.getElementById('actionToggleWatchedBtn').innerText = isWatched ? 'Mark not watched' : 'Mark watched';
      document.getElementById('actionSheetOverlay').style.display = 'grid';
    }

    function openActionSheetForMovie(event, sheetName, rowIndex, title, isWatched) {
      event.stopPropagation();
      activeItemTarget = {
        sheetName: sheetName,
        rowIndex: rowIndex,
        title: title,
        isWatched: isWatched
      };

      document.getElementById('actionSheetTitle').innerText = isWatched ? 'Watched' : title;
      document.getElementById('actionToggleWatchedBtn').innerText = isWatched ? 'Mark not watched' : 'Mark watched';
      document.getElementById('actionSheetOverlay').style.display = 'grid';
    }

    function closeActionSheet() {
      document.getElementById('actionSheetOverlay').style.display = 'none';
      activeItemTarget = null;
    }

    function handleActionToggleWatched() {
      if (!activeItemTarget) return;
      var newWatched = !activeItemTarget.isWatched;

      showToast('Updating status...');
      closeActionSheet();

      GAS.run.withSuccessHandler(function(res) {
        showToast(res.message);
        GAS.run.withSuccessHandler(onDataLoaded).getWebAppData();
      }).apiMarkWatched({
        sheetName: activeItemTarget.sheetName,
        rowIndices: [activeItemTarget.rowIndex],
        isWatched: newWatched,
        dateWatched: newWatched ? new Date().toLocaleDateString('en-GB') : ''
      });
    }

    function handleActionRewatched() {
      if (!activeItemTarget) return;
      showToast('Recording rewatch...');
      closeActionSheet();

      GAS.run.withSuccessHandler(function(res) {
        showToast('Rewatch recorded.');
        GAS.run.withSuccessHandler(onDataLoaded).getWebAppData();
      }).apiMarkWatched({
        sheetName: activeItemTarget.sheetName,
        rowIndices: [activeItemTarget.rowIndex],
        isWatched: true,
        dateWatched: new Date().toLocaleDateString('en-GB')
      });
    }

    function handleActionEditDate() {
      if (!activeItemTarget) return;
      var newDate = prompt('Enter watch date (DD/MM/YYYY):', new Date().toLocaleDateString('en-GB'));
      if (newDate) {
        showToast('Updating date...');
        closeActionSheet();

        GAS.run.withSuccessHandler(function(res) {
          showToast(res.message);
          GAS.run.withSuccessHandler(onDataLoaded).getWebAppData();
        }).apiEditWatchDate({
          sheetName: activeItemTarget.sheetName,
          rowIndices: [activeItemTarget.rowIndex],
          newDate: newDate
        });
      }
    }

    function openAddModal() { document.getElementById('addModal').style.display = 'grid'; }
    function closeAddModal() { document.getElementById('addModal').style.display = 'none'; }

    function searchTMDB() {
      var q = document.getElementById('tmdbSearchInput').value.trim();
      var type = document.getElementById('tmdbTypeSelect').value;
      if (!q) return;

      var container = document.getElementById('tmdbResults');
      container.innerHTML = '<div style="color:var(--text-sub); text-align:center;">Searching...</div>';

      GAS.run
        .withSuccessHandler(function(results) {
          container.innerHTML = '';
          if (!results || results.length === 0) {
            container.innerHTML = '<div style="color:var(--text-sub); text-align:center;">No results found.</div>';
            return;
          }
          results.forEach(function(item) {
            // Shows: dd/mm/yyyy.  Movies are shown as before.
            var dateText = (type === 'tv') ? isoToDMY(item.date) : (item.date || '');

            var row = document.createElement('div');
            row.style.cssText = 'display:flex; align-items:center; justify-content:space-between; background:#1c1c1e; padding:0.6rem; border-radius:12px; gap:0.6rem;';

            var left = document.createElement('div');
            left.style.cssText = 'flex:1; min-width:0; font-size:0.88rem; color:#fff;';

            var titleEl = document.createElement('span');
            titleEl.className = 'search-result-title';
            titleEl.textContent = item.title;
            titleEl.onclick = function() {
              openMediaDetail({
                title: item.title,
                tmdbId: item.id,
                type: type,
                date: isoToDMY(item.date),
                synopsis: item.overview || '',
                rating: item.rating || ''
              });
            };

            var dateEl = document.createElement('span');
            dateEl.style.color = 'var(--text-sub)';
            dateEl.textContent = dateText ? ' (' + dateText + ')' : '';

            left.appendChild(titleEl);
            left.appendChild(dateEl);

            var btn = document.createElement('button');
            btn.className = 'action-sheet-btn';
            btn.style.cssText = 'width:auto; padding:0.4rem 0.8rem; font-size:0.8rem; background:var(--accent-red); flex-shrink:0;';
            btn.textContent = '+ Add';
            btn.onclick = function() { addMediaDirect(item.id, type, item.title); };

            row.appendChild(left);
            row.appendChild(btn);
            container.appendChild(row);
          });
        })
        .withFailureHandler(function(err) {
          container.innerHTML = '<div style="color:#ff3b30; text-align:center;">Search failed: ' + escapeHtml((err && err.message) || err) + '</div>';
        })
        .apiSearchTMDB(q, type);
    }

    function addMediaDirect(id, type, title) {
      closeAddModal();
      showAddPopup('loading', title, type);
      GAS.run
        .withSuccessHandler(function(res) {
          if (res && res.success) {
            showAddPopup('success', title, type);
            refreshDataQuietly();
          } else {
            showAddPopup('error', title, type, res && res.message);
          }
        })
        .withFailureHandler(function(err) {
          showAddPopup('error', title, type, err && err.message);
        })
        .apiAddMedia(id, type);
    }

    function refreshDataQuietly() {
      GAS.run.withSuccessHandler(function(data) {
        applyLoadedData(data);
        renderCurrentCategoryView();
      }).getWebAppData();
    }

    /* ---------- Added-to-library popup ---------- */
    var addPopupTimer = null;

    var AP_SPINNER = '<div class="ap-spinner"></div>';
    var AP_CHECK = '<svg viewBox="0 0 52 52" width="76" height="76"><circle class="ap-circle" cx="26" cy="26" r="24" fill="none" stroke="#34c759" stroke-width="3"/><path class="ap-check" fill="none" stroke="#34c759" stroke-width="4" stroke-linecap="round" stroke-linejoin="round" d="M14 27l8 8 16-17"/></svg>';
    var AP_ERROR = '<svg viewBox="0 0 52 52" width="76" height="76"><circle class="ap-circle" cx="26" cy="26" r="24" fill="none" stroke="#ff3b30" stroke-width="3"/><path class="ap-check" fill="none" stroke="#ff3b30" stroke-width="4" stroke-linecap="round" d="M17 17l18 18M35 17L17 35"/></svg>';

    function showAddPopup(state, title, type, errMsg) {
      var overlay = document.getElementById('addPopupOverlay');
      var icon = document.getElementById('addPopupIcon');
      var titleEl = document.getElementById('addPopupTitle');
      var msgEl = document.getElementById('addPopupMsg');
      var isMovie = (String(type).toLowerCase().indexOf('movie') !== -1);
      var shown = '\u201c' + (title || 'Item') + '\u201d';

      clearTimeout(addPopupTimer);

      if (state === 'loading') {
        icon.className = 'add-popup-icon';
        icon.innerHTML = AP_SPINNER;
        titleEl.textContent = 'Adding to library...';
        msgEl.textContent = shown;
      } else if (state === 'success') {
        icon.className = 'add-popup-icon';
        icon.innerHTML = AP_CHECK;
        void icon.offsetWidth;
        icon.className = 'add-popup-icon pop';
        titleEl.textContent = 'Added to your library';
        msgEl.textContent = shown + ' was added to ' + (isMovie ? 'Movies' : 'Shows') + '.';
        addPopupTimer = setTimeout(hideAddPopup, 2800);
      } else {
        icon.className = 'add-popup-icon';
        icon.innerHTML = AP_ERROR;
        titleEl.textContent = 'Could not add';
        msgEl.textContent = errMsg || 'Something went wrong. Please try again.';
        addPopupTimer = setTimeout(hideAddPopup, 4500);
      }

      if (overlay.style.display !== 'grid') {
        overlay.style.display = 'grid';
        setTimeout(function() { overlay.classList.add('show'); }, 10);
      }
    }

    function hideAddPopup() {
      clearTimeout(addPopupTimer);
      var overlay = document.getElementById('addPopupOverlay');
      overlay.classList.remove('show');
      setTimeout(function() {
        if (!overlay.classList.contains('show')) overlay.style.display = 'none';
      }, 250);
    }

    /* ---------- Small helpers ---------- */
    function yearOf(d) {
      var m = String(d || '').match(/(19|20)\d{2}/);
      if (m) return m[0];
      return (d === 'TBC') ? 'TBC' : '';
    }

    function isoToDMY(s) {
      var m = String(s || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
      return m ? (m[3] + '/' + m[2] + '/' + m[1]) : (s || '');
    }

    function showToast(msg) {
      var toast = document.getElementById('toast');
      toast.innerText = msg;
      toast.style.display = 'block';
      setTimeout(function() { toast.style.display = 'none'; }, 2500);
    }

    function escapeHtml(str) {
      if (!str) return '';
      return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');
    }

    function handleMarkWatched(rowIndex, sheetName, isWatched) {
  // Show a quick loading toast or indicator if you have one
  console.log("Marking row " + rowIndex + " in " + sheetName + " as watched: " + isWatched);

  GAS.run
    .withSuccessHandler(function(response) {
      if (response && response.success) {
        // Refresh your web app view or reload to reflect changes
        location.reload();
      } else {
        alert("Failed to update: " + (response ? response.message : "Unknown error"));
      }
    })
    .withFailureHandler(function(err) {
      alert("Script error: " + err.message);
    })
    .apiMarkWatched({
      rowIndices: [parseInt(rowIndex, 10)],
      sheetName: sheetName,
      isWatched: isWatched
    });
}

function toggleWatchedDirectly(event, sheetName, rowIndex, isWatched) {
  event.stopPropagation();
  var newWatched = !isWatched;

  var btn = event.currentTarget;
  var card = btn.closest('.bingers-list-card') || btn.closest('.bingers-grid-card');

  // Step 1: Trigger the scale-up pulse and swap to the green checkmark
  btn.classList.add('animating-tick');
  btn.innerHTML = greenCheckSvg;

  // Step 2: Settle back to normal size briefly, then trigger card exit animation
  setTimeout(function() {
    btn.classList.remove('animating-tick');
  }, 160);

  setTimeout(function() {
    if (card) {
      card.classList.add('animating-out');
    }
  }, 260);

  // Step 3: Fire backend API call and refresh view after animation completes
  setTimeout(function() {
    GAS.run
      .withSuccessHandler(function(res) {
        showToast(res.message || 'Updated successfully');
        GAS.run.withSuccessHandler(function(data) {
          rawData = data;
          renderCurrentCategoryView();
        }).getWebAppData();
      })
      .withFailureHandler(function(err) {
        alert('Error updating status: ' + err.message);
        renderCurrentCategoryView(); // Revert view on error
      })
      .apiMarkWatched({
        sheetName: sheetName,
        rowIndices: [parseInt(rowIndex, 10)],
        isWatched: newWatched,
        dateWatched: newWatched ? new Date().toLocaleDateString('en-GB') : ''
      });
  }, 420); // Total animation window before data refresh
}

let currentDetailItem = null;
    let bulkWatchTargetState = false;

    function openMediaDetail(item) {
      currentDetailItem = item;
      const overlay = document.getElementById('mediaDetailOverlay');
      overlay.style.display = 'block';

      document.getElementById('detailTitle').innerText = item.title;
      const hero = document.getElementById('detailHero');
      hero.style.backgroundImage = 'none';

      // Fetch live TMDb details for rich media info
      const typeStr = (item.type && item.type.toLowerCase().includes('movie')) ? 'movie' : 'tv';
      const tmdbId = item.tmdbId;

      if (tmdbId && /^\d{1,10}$/.test(String(tmdbId))) {
        GAS.run
          .withSuccessHandler(function(data) {
            if (currentDetailItem !== item) return;
            renderDetailContent(item, data, typeStr);
          })
          .withFailureHandler(function() {
            if (currentDetailItem !== item) return;
            renderDetailContent(item, null, typeStr);
          })
          .apiTmdbDetails(typeStr, String(tmdbId));
      } else {
        renderDetailContent(item, null, typeStr);
      }
    }

    function closeMediaDetail() {
      document.getElementById('mediaDetailOverlay').style.display = 'none';
      currentDetailItem = null;
    }

    function renderDetailContent(item, tmdbData, typeStr) {
      var body = document.getElementById('detailBodyContent');
      var hero = document.getElementById('detailHero');
      var safeTmdbId = String(item.tmdbId || '').replace(/\D/g, '');

      var backdropPath = tmdbData && tmdbImgPath(tmdbData.backdrop_path) ? 'https://image.tmdb.org/t/p/w1280' + tmdbImgPath(tmdbData.backdrop_path) : '';
      var posterPath = tmdbData && tmdbImgPath(tmdbData.poster_path) ? 'https://image.tmdb.org/t/p/w500' + tmdbImgPath(tmdbData.poster_path) : '';
      hero.style.backgroundImage = backdropPath ? 'url(\'' + backdropPath + '\')' : (posterPath ? 'url(\'' + posterPath + '\')' : 'none');

      var isInList = false;
      var matchingSheetRow = null;
      if (typeStr === 'movie') {
        var foundMovie = rawData.movies.find(function(m) { return m.tmdbId === item.tmdbId || m.title.toLowerCase() === item.title.toLowerCase(); });
        if (foundMovie) { isInList = true; matchingSheetRow = foundMovie; }
      } else {
        var foundTv = rawData.tvShows.find(function(t) { return t.tmdbId === item.tmdbId || t.title.toLowerCase() === item.title.toLowerCase(); });
        if (foundTv) { isInList = true; matchingSheetRow = foundTv; }
      }

      var status = tmdbData ? (tmdbData.status || (typeStr === 'movie' ? (tmdbData.release_date ? 'Released' : 'Un-released') : 'Continuing')) : 'Continuing';
      var releaseYear = tmdbData ? (tmdbData.release_date || tmdbData.first_air_date || '').substring(0, 4) : (item.date ? item.date.substring(item.date.length - 4) : '');
      var runtime = tmdbData ? (typeStr === 'movie' ? (tmdbData.runtime || 90) + ' min' : ((tmdbData.episode_run_time && tmdbData.episode_run_time[0]) || 43) + ' min') : '43 min';
      var network = (tmdbData && tmdbData.networks && tmdbData.networks[0]) ? tmdbData.networks[0].name : (typeStr === 'movie' ? 'Movie' : 'Streaming');

      var synopsis = tmdbData ? (tmdbData.overview || item.synopsis || 'No synopsis available.') : (item.synopsis || 'No synopsis available.');
      var genres = tmdbData && tmdbData.genres ? tmdbData.genres.map(function(g) { return g.name; }).join(' · ') : (item.genre || 'Drama');
      var tmdbRating = tmdbData && tmdbData.vote_average ? tmdbData.vote_average.toFixed(1) : (item.rating && item.rating !== 'TBC' ? item.rating : '\u2014');
      var imdbRating = item.imdbRating && item.imdbRating !== 'TBC' ? item.imdbRating : '\u2014';
      var imdbId = (tmdbData && tmdbData.external_ids && /^tt\d+$/.test(tmdbData.external_ids.imdb_id || '')) ? tmdbData.external_ids.imdb_id : '';

      var html = '<div class="detail-actions-row">';
      if (isInList) {
        html += '<button class="action-pill-btn in-list" data-act="handleRemoveFromList" data-a="' + escapeHtml(typeStr) + '" data-b="' + safeTmdbId + '" data-c="' + escapeHtml(item.title) + '" title="Remove from list">' +
                '<svg width="22" height="22" viewBox="0 0 24 24" fill="#ffffff" stroke="#ffffff" stroke-width="2"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg>' +
                '</button>';
      } else {
        html += '<button class="action-pill-btn" data-act="handleAddToList" data-a="' + escapeHtml(typeStr) + '" data-b="' + safeTmdbId + '">' +
                '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg>' +
                'Add to list</button>';
      }

      if (typeStr === 'movie') {
        var isWatched = matchingSheetRow && (matchingSheetRow.status === true || matchingSheetRow.status === 'TRUE');
        html += '<button class="action-circle-btn" data-act="toggleMovieWatchedDirect" data-a="' + escapeHtml(typeStr) + '" data-b="' + (matchingSheetRow ? (parseInt(matchingSheetRow.rowIndex, 10) || 0) : 0) + '" data-c="' + (isWatched ? 'true' : 'false') + '">' +
                (isWatched ? greenCheckSvg : greyCircleCheckSvg) + '</button>';
      } else {
        html += '<button class="action-circle-btn" data-act="promptBulkWatch">' + greyCircleCheckSvg + '</button>';
      }
      html += '</div>';

      html += '<div class="detail-meta-sub">' + escapeHtml(status) + ' · ' + escapeHtml(releaseYear) + ' · ' + escapeHtml(runtime) + ' · ' + escapeHtml(network) + '</div>';
      html += '<div class="detail-synopsis">' + escapeHtml(synopsis) + '</div>';
      html += '<div class="detail-genres">' + escapeHtml(genres) + '</div>';

      html += '<div class="detail-ratings-row">' +
              '<div class="rating-badge">⭐ ' + escapeHtml(imdbRating) + '</div>' +
              '<div class="rating-badge">TMDB ' + escapeHtml(tmdbRating) + '</div>' +
              (imdbId ? '<a class="rating-badge" href="https://www.imdb.com/title/' + imdbId + '" target="_blank" rel="noopener noreferrer">IMDb ↗</a>' : '') +
              '</div>';

      if (typeStr === 'tv') {
        html += '<div class="section-title" style="margin-top:1rem;">Seasons</div>';
        if (tmdbData && tmdbData.seasons) {
          tmdbData.seasons.forEach(function(season) {
            if (season.season_number === 0 && season.episode_count === 0) return;
            html += '<div class="season-accordion-item">' +
                    '<div class="season-header-row" data-act="toggleSeasonAccordion" data-a="' + safeTmdbId + '" data-b="' + (parseInt(season.season_number, 10) || 0) + '">' +
                    '<span>' + escapeHtml(season.name) + '</span>' +
                    '<span style="color:var(--text-sub); font-size:0.85rem;">' + (parseInt(season.episode_count, 10) || 0) + ' episodes ▼</span>' +
                    '</div>' +
                    '<div class="episode-list-container" id="season-episodes-' + safeTmdbId + '-' + (parseInt(season.season_number, 10) || 0) + '">' +
                    '<div style="padding:0.75rem 1.25rem; color:var(--text-sub); font-size:0.82rem;">Loading episodes...</div>' +
                    '</div>' +
                    '</div>';
          });
        }
      }

      if (tmdbData && tmdbData.credits && tmdbData.credits.cast && tmdbData.credits.cast.length > 0) {
        html += '<div class="section-title" style="margin-top:1rem;">Cast</div>';
        html += '<div class="cast-scroll-row">';
        tmdbData.credits.cast.slice(0, 15).forEach(function(actor) {
          var actorPhoto = tmdbImgPath(actor.profile_path) ? 'https://image.tmdb.org/t/p/w185' + tmdbImgPath(actor.profile_path) : 'data:image/svg+xml;charset=UTF-8,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%22100%22%20height%3D%22140%22%3E%3Crect%20width%3D%22100%25%22%20height%3D%22100%25%22%20fill%3D%22%23242426%22%2F%3E%3C/svg%3E';
          html += '<div class="cast-card">' +
                  '<img class="cast-photo" src="' + actorPhoto + '" loading="lazy" alt="">' +
                  '<div class="cast-name">' + escapeHtml(actor.name) + '</div>' +
                  '<div class="cast-character">' + escapeHtml(actor.character || '') + '</div>' +
                  '</div>';
        });
        html += '</div>';
      }

      body.innerHTML = html;
    }

    function episodeKey(season, episode) {
      return 'S' + parseInt(season, 10) + 'E' + parseInt(episode, 10);
    }

    /* Episodes of this show as they exist in the spreadsheet, keyed by season/episode number */
    function getLocalEpisodeMap(item) {
      var map = {};
      if (!item) return map;
      var tid = String(item.tmdbId || '');
      var t = String(item.title || '').toLowerCase();
      var block = parseTVShowBlocks(rawData.tvShows).find(function(b) {
        return (tid && b.show.tmdbId === tid) || b.show.title.toLowerCase() === t;
      });
      if (!block) return map;
      block.episodes.forEach(function(ep) {
        var m = String(ep.item.title || '').match(/S(\d+)E(\d+)/i);
        if (m) map[episodeKey(m[1], m[2])] = ep;
      });
      return map;
    }

    function toggleSeasonAccordion(headerElem, tmdbId, seasonNum) {
      const container = document.getElementById('season-episodes-' + tmdbId + '-' + seasonNum);
      if (!container) return;
      if (container.style.display === 'block') {
        container.style.display = 'none';
        return;
      }
      container.style.display = 'block';

      // Fetch season episodes (through the backend) if not already loaded
      if (container.dataset.loaded === 'true') return;

      GAS.run
        .withSuccessHandler(function(seasonData) {
          container.dataset.loaded = 'true';
          if (!seasonData || !seasonData.episodes || seasonData.episodes.length === 0) {
            container.innerHTML = '<div style="padding:0.75rem 1.25rem; color:var(--text-sub);">No episodes found.</div>';
            return;
          }

          var localEps = getLocalEpisodeMap(currentDetailItem);

          let epHtml = '';
          seasonData.episodes.forEach(ep => {
            const epTagNum = 'S' + String(seasonNum).padStart(2,'0') + 'E' + String(ep.episode_number).padStart(2,'0');
            var local = localEps[episodeKey(seasonNum, ep.episode_number)];

            var tickHtml = '';
            if (local) {
              tickHtml = '<button class="tick-action-btn" data-act="toggleEpisodeTick" data-row="' + (parseInt(local.item.rowIndex, 10) || 0) + '" data-sheet="' + escapeHtml(local.item.sheetName || 'TV shows') + '" data-watched="' + (local.isWatched ? '1' : '0') + '">' +
                (local.isWatched ? greenCheckSvg : greyCircleCheckSvg) + '</button>';
            }

            epHtml += '<div class="episode-row" style="gap:0.75rem;">' +
              '<div style="flex:1; min-width:0;">' +
              '<div style="font-weight:600; font-size:0.9rem; color:#fff;">' + escapeHtml(ep.name) + '</div>' +
              '<div style="font-size:0.78rem; color:var(--text-sub);">' + epTagNum + ' \u00b7 ' + escapeHtml(ep.air_date || 'TBC') + '</div>' +
              '</div>' +
              tickHtml +
              '</div>';
          });
          container.innerHTML = epHtml;
        })
        .withFailureHandler(function() {
          container.innerHTML = '<div style="padding:0.75rem 1.25rem; color:var(--text-sub);">Failed to load episodes.</div>';
        })
        .apiTmdbSeason(tmdbId, seasonNum);
    }

    function toggleEpisodeTick(event, btn) {
      event.stopPropagation();
      if (btn.dataset.busy === '1') return;

      var row = parseInt(btn.dataset.row, 10);
      var wasWatched = btn.dataset.watched === '1';
      var newWatched = !wasWatched;

      function setState(watched) {
        btn.dataset.watched = watched ? '1' : '0';
        btn.innerHTML = watched ? greenCheckSvg : greyCircleCheckSvg;
      }

      btn.dataset.busy = '1';
      setState(newWatched);
      btn.classList.add('animating-tick');
      setTimeout(function() { btn.classList.remove('animating-tick'); }, 160);

      GAS.run
        .withSuccessHandler(function(res) {
          btn.dataset.busy = '0';
          if (!res || !res.success) {
            setState(wasWatched);
            showToast((res && res.message) || 'Could not update episode');
            return;
          }
          refreshDataQuietly();
        })
        .withFailureHandler(function(err) {
          btn.dataset.busy = '0';
          setState(wasWatched);
          showToast('Could not update episode');
        })
        .apiMarkWatched({
          sheetName: btn.dataset.sheet,
          rowIndices: [row],
          isWatched: newWatched,
          dateWatched: newWatched ? new Date().toLocaleDateString('en-GB') : ''
        });
    }

    function handleAddToList(typeStr, tmdbId) {
      var title = currentDetailItem ? currentDetailItem.title : 'Item';
      showAddPopup('loading', title, typeStr);
      GAS.run
        .withSuccessHandler(res => {
          if (res && res.success) {
            closeMediaDetail();
            closeAddModal();
            showAddPopup('success', title, typeStr);
            refreshDataQuietly();
          } else {
            showAddPopup('error', title, typeStr, res && res.message);
          }
        })
        .withFailureHandler(err => {
          showAddPopup('error', title, typeStr, err && err.message);
        })
        .apiAddMedia(tmdbId, typeStr);
    }

    function handleRemoveFromList(typeStr, tmdbId, title) {
      if (!confirm('Remove "' + title + '" from your list?')) return;
      showToast('Removing...');
      const sheetName = typeStr === 'movie' ? 'Movies' : 'TV shows';
      GAS.run.withSuccessHandler(res => {
        showToast(res.message);
        GAS.run.withSuccessHandler(data => {
          rawData = data;
          renderCurrentCategoryView();
          closeMediaDetail();
        }).getWebAppData();
      }).apiRemoveMedia({ sheetName: sheetName, tmdbId: tmdbId, title: title });
    }

    function toggleMovieWatchedDirect(typeStr, rowIndex, isWatched) {
      if (!rowIndex) return;
      const newWatched = !isWatched;
      showToast('Updating status...');
      GAS.run.withSuccessHandler(res => {
        showToast(res.message);
        GAS.run.withSuccessHandler(data => {
          rawData = data;
          renderCurrentCategoryView();
          closeMediaDetail();
        }).getWebAppData();
      }).apiMarkWatched({ sheetName: 'Movies', rowIndices: [rowIndex], isWatched: newWatched });
    }

    function promptBulkWatch() {
      document.getElementById('confirmModal').style.display = 'grid';
    }

    function closeConfirmModal() {
      document.getElementById('confirmModal').style.display = 'none';
    }

    function executeBulkWatch() {
      closeConfirmModal();
      showToast('Updating all episodes...');
      // Find all episode row indices for this TV show in rawData.tvShows matching currentDetailItem.tmdbId
      const showBlock = rawData.tvShows.find(t => t.tmdbId === currentDetailItem.tmdbId || t.title.toLowerCase() === currentDetailItem.title.toLowerCase());
      // Collect episode row indices from rawData.tvShows starting after show header
      let episodeRowIndices = [];
      let collecting = false;
      rawData.tvShows.forEach(row => {
        const rawTitle = row.title ? row.title.trim() : '';
        const isSeasonHeader = /^Season\s+\d+/i.test(rawTitle);
        const isEpisode = /^S\d+E\d+/i.test(rawTitle);
        const isShowHeader = !isSeasonHeader && !isEpisode && rawTitle !== '';

        if (isShowHeader) {
          if (row.tmdbId === currentDetailItem.tmdbId || rawTitle.toLowerCase() === currentDetailItem.title.toLowerCase()) {
            collecting = true;
          } else if (collecting) {
            collecting = false;
          }
        } else if (collecting && isEpisode) {
          episodeRowIndices.push(row.rowIndex);
        }
      });

      if (episodeRowIndices.length > 0) {
        GAS.run.withSuccessHandler(res => {
          showToast(res.message);
          GAS.run.withSuccessHandler(data => {
            rawData = data;
            renderCurrentCategoryView();
            closeMediaDetail();
          }).getWebAppData();
        }).apiMarkWatched({ sheetName: 'TV shows', rowIndices: episodeRowIndices, isWatched: true });
      } else {
        showToast('No episodes found in spreadsheet for this show.');
      }
    }



    /* ================================================================
       Delegated click handling.
       Nothing in the markup contains inline JavaScript any more: elements
       carry data-act (+ data-a / data-b / data-c values, always HTML-escaped
       attribute text) and are routed here. The nearest data-act element
       wins and the click stops there (replaces the old stopPropagation calls).
       ================================================================ */
    function eventFor(el, ev) {
      return { currentTarget: el, target: ev.target, stopPropagation: function() {}, preventDefault: function() {} };
    }

    var ACTIONS = {
      noop: function() {},
      reloadPage: function() { location.reload(); },
      submitLogin: function() { submitLogin(); },
      lockDevice: function() { lockDevice(); },

      togglePopoverMenu: function() { togglePopoverMenu(); },
      closePopoverMenu: function() { closePopoverMenu(); },
      openAddModal: function() { openAddModal(); },
      closeAddModal: function() { closeAddModal(); },
      searchTMDB: function() { searchTMDB(); },
      closeActionSheet: function() { closeActionSheet(); },
      handleActionRewatched: function() { handleActionRewatched(); },
      handleActionEditDate: function() { handleActionEditDate(); },
      handleActionToggleWatched: function() { handleActionToggleWatched(); },
      hideAddPopup: function() { hideAddPopup(); },
      closeMediaDetail: function() { closeMediaDetail(); },
      toggleDetailOptions: function() {},
      executeBulkWatch: function() { executeBulkWatch(); },
      closeConfirmModal: function() { closeConfirmModal(); },
      promptBulkWatch: function() { promptBulkWatch(); },
      refreshData: function() { refreshData(); },

      switchMainCategory: function(el) { switchMainCategory(el.dataset.a, el); },
      subMenu: function(el) { activeSubMenu = el.dataset.a; renderPopoverContent(); },
      setGenreFilter: function(el) { setGenreFilter(el.dataset.a); },
      setViewMode: function(el) { setViewMode(el.dataset.a); },
      toggleTvStatus: function(el) { toggleTvStatus(el.dataset.a); },
      setMovieSort: function(el) { setMovieSort(el.dataset.a); },
      toggleMovieStatus: function(el) { toggleMovieStatus(el.dataset.a); },
      toggleExploreOption: function(el) { toggleExploreOption(el.dataset.a); },
      changeResumeWeeks: function(el) { changeResumeWeeks(parseInt(el.dataset.a, 10)); },

      toggleWatchedDirectly: function(el, ev) {
        toggleWatchedDirectly(eventFor(el, ev), el.dataset.a, parseInt(el.dataset.b, 10), el.dataset.c === 'true');
      },
      handleRemoveFromList: function(el) { handleRemoveFromList(el.dataset.a, el.dataset.b, el.dataset.c); },
      handleAddToList: function(el) { handleAddToList(el.dataset.a, el.dataset.b); },
      toggleMovieWatchedDirect: function(el) {
        toggleMovieWatchedDirect(el.dataset.a, parseInt(el.dataset.b, 10), el.dataset.c === 'true');
      },
      toggleSeasonAccordion: function(el) { toggleSeasonAccordion(el, el.dataset.a, parseInt(el.dataset.b, 10)); },
      toggleEpisodeTick: function(el, ev) { toggleEpisodeTick(eventFor(el, ev), el); }
    };

    document.addEventListener('click', function(ev) {
      var el = (ev.target && ev.target.closest) ? ev.target.closest('[data-act]') : null;
      if (!el) return;
      var name = el.getAttribute('data-act');
      if (!Object.prototype.hasOwnProperty.call(ACTIONS, name)) return;
      ev.stopPropagation();
      ACTIONS[name](el, ev);
    }, true);

    document.getElementById('searchInput').addEventListener('input', onSearchInput);
    document.getElementById('loginInput').addEventListener('keydown', function(ev) {
      if (ev.key === 'Enter') submitLogin();
    });

    /* ---------- start-up ---------- */
    (function boot() {
      // one-time convenience: https://…/media-tracker/#<access code> stores the code, then removes it from the address bar
      var h = (location.hash || '').replace(/^#/, '');
      if (/^[A-Za-z0-9]{16,64}$/.test(h)) {
        setAccessCode(h);
        try { history.replaceState(null, '', location.pathname + location.search); } catch (e) {}
      }
      if (getAccessCode()) startLoad();
      else showLogin('');
    })();
