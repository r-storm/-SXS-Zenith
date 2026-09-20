/* Zenith guild tracker. Reads data/snapshots/<date>/{week,profiles}.json and
   renders the rankings dashboard and per-player profiles. No build step.
   Routes: "#" is the dashboard, "#rankings" the table, "#timeline" the server
   schedule and "#<slug>" one player. They show the latest snapshot; a date in
   front, as in "#<date>/<slug>", shows an earlier one. */
(function () {
  'use strict';

  var app = document.getElementById('app');
  var topbar = document.getElementById('topbar');
  var dock = document.getElementById('dock');
  var state = { dirs: [], latest: null, meta: null, players: [], sortKey: 'power_n', sortDir: 'desc', query: '', classFilter: null };
  var noMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (noMotion) document.documentElement.classList.add('no-motion');

  // ---- helpers -------------------------------------------------------------

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function icon(name, cls) {
    return '<svg class="' + (cls || 'size-4') + ' shrink-0" aria-hidden="true"><use href="#i-' + name + '"/></svg>';
  }

  function parseNum(s) {
    if (s == null) return null;
    s = String(s).trim();
    var m = /^\+?([0-9]+(?:\.[0-9]+)?)\s*([KMBT]?)$/i.exec(s);
    if (!m) return null;
    var mult = { '': 1, K: 1e3, M: 1e6, B: 1e9, T: 1e12 }[m[2].toUpperCase()];
    return parseFloat(m[1]) * mult;
  }

  function fmtNum(n) {
    if (n == null) return '-';
    var abs = Math.abs(n), sign = n < 0 ? '-' : '';
    var units = [[1e12, 'T'], [1e9, 'B'], [1e6, 'M'], [1e3, 'K']];
    for (var i = 0; i < units.length; i++) {
      if (abs >= units[i][0]) {
        var v = abs / units[i][0];
        var str = v >= 100 ? Math.round(v).toString() : v >= 10 ? (Math.round(v * 10) / 10).toString() : (Math.round(v * 100) / 100).toString();
        return sign + str + units[i][1];
      }
    }
    return sign + Math.round(abs).toLocaleString();
  }

  function fmtDelta(now, before) {
    if (now == null || before == null) return '';
    var d = now - before;
    if (Math.abs(d) < 0.5) return '±0';
    return (d > 0 ? '+' : '-') + fmtNum(Math.abs(d));
  }

  function deltaHTML(d) {
    if (!d) return '';
    var cls = d.charAt(0) === '+' ? 'text-emerald-600 dark:text-emerald-400' : d.charAt(0) === '-' ? 'text-red-600 dark:text-red-400' : 'text-zinc-500';
    return '<span class="text-xs font-medium ' + cls + '">' + esc(d) + '</span>';
  }

  function slugify(name) {
    var s = String(name).toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '');
    s = s.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    return s || 'player';
  }

  function loginMinutes(login) {
    if (login == null) return null;
    login = String(login).trim();
    if (/^online$/i.test(login)) return 0;
    var m = /^(\d+)\s*([mhd])$/i.exec(login);
    if (!m) return null;
    var n = parseInt(m[1], 10);
    return { m: n, h: n * 60, d: n * 1440 }[m[2].toLowerCase()];
  }

  function fmtDate(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
  }

  // Snapshot folders are named by local calendar day, so they are parsed by
  // hand: new Date('2026-09-15') is UTC midnight and shows as the 14th in the
  // Americas.
  function dirDate(dir) {
    var a = String(dir).split('-').map(Number);
    return new Date(a[0], a[1] - 1, a[2]);
  }

  function fmtDay(dir) { return fmtDate(dirDate(dir)); }

  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  // Link to the rankings (no slug) or a player, staying in the snapshot being
  // viewed unless another one is named.
  function link(slug, dir) {
    dir = dir || (state.meta && state.meta.dir) || state.latest;
    if (dir === state.latest) return '#' + (slug || '');
    return '#' + dir + (slug ? '/' + slug : '');
  }

  function ordinal(n) {
    var r = n % 100, suffix = 'th';
    if (r < 11 || r > 13) suffix = ['th', 'st', 'nd', 'rd'][n % 10] || 'th';
    return n + suffix;
  }

  function classKey(p) {
    var c = p.profile && p.profile['class'] ? String(p.profile['class']).toLowerCase() : '';
    return ['destroyer', 'dominator', 'conqueror', 'guardian'].indexOf(c) !== -1 ? c : 'unknown';
  }

  function classBadge(p, extra) {
    var key = classKey(p);
    var label = key === 'unknown' ? 'Class not captured' : p.profile['class'];
    return '<span class="cls cls-' + key + (extra ? ' ' + extra : '') + '" title="' + esc(label) + '">' + icon('cls-' + key) + '</span>';
  }

  function roleTag(p) {
    if (p.role === 'Leader') return '<span class="tag tag-leader">' + icon('crown') + 'Leader</span>';
    if (p.role === 'Deputy') return '<span class="tag tag-deputy">' + icon('star') + 'Deputy</span>';
    return '';
  }

  function fetchJSON(url) {
    return fetch(url, { cache: 'no-cache' }).then(function (r) {
      if (!r.ok) throw new Error('Could not load ' + url + ' (' + r.status + ')');
      return r.json();
    });
  }

  // ---- motion ----------------------------------------------------------------

  function countUp(el, target, finalText) {
    if (noMotion || target == null || !el) { if (el) el.textContent = finalText; return; }
    var start = null, dur = 900;
    function step(ts) {
      if (start == null) start = ts;
      var t = Math.min(1, (ts - start) / dur);
      var eased = 1 - Math.pow(1 - t, 3);
      el.textContent = fmtNum(target * eased);
      if (t < 1) requestAnimationFrame(step); else el.textContent = finalText;
    }
    requestAnimationFrame(step);
  }

  // ---- data ----------------------------------------------------------------

  var rawCache = {}, snapCache = {};
  var PROFILE_LOOKBACK = 8;

  function loadRaw(dir) {
    if (rawCache[dir]) return rawCache[dir];
    var base = 'data/snapshots/' + dir + '/';
    var req = Promise.all([
      fetchJSON(base + 'week.json'),
      fetchJSON(base + 'profiles.json').catch(function () { return { profiles: [] }; })
    ]).then(function (res) {
      (res[1].profiles || []).forEach(function (pr) { pr.snapshot = dir; });
      return { dir: dir, week: res[0], profiles: res[1] };
    });
    req.catch(function () { delete rawCache[dir]; });
    return rawCache[dir] = req;
  }

  // Profile screens are not captured every week. Members without one in this
  // snapshot borrow their most recent earlier capture, looking back a few
  // snapshots at most; pr.snapshot says which folder it came from.
  function loadSnapshot(dir) {
    if (snapCache[dir]) return snapCache[dir];
    var older = state.dirs.filter(function (d) { return d < dir; }).reverse().slice(0, PROFILE_LOOKBACK);
    var req = loadRaw(dir).then(function (raw) {
      var names = (raw.week.roster || []).concat(raw.week.conquest || []).map(function (r) { return r.name; });
      var have = {}, borrowed = [];
      (raw.profiles.profiles || []).forEach(function (pr) { have[pr.name] = true; });
      function walk(k) {
        var missing = names.some(function (n) { return !have[n]; });
        if (!missing || k >= older.length) return buildSnapshot(raw, borrowed);
        return loadRaw(older[k]).then(function (r) {
          (r.profiles.profiles || []).forEach(function (pr) {
            if (have[pr.name] || names.indexOf(pr.name) === -1) return;
            have[pr.name] = true;
            borrowed.push(pr);
          });
        }, function () {}).then(function () { return walk(k + 1); });
      }
      return walk(0);
    });
    req.catch(function () { delete snapCache[dir]; });
    return snapCache[dir] = req;
  }

  function buildSnapshot(raw, borrowed) {
    var dir = raw.dir, week = raw.week;
    var profiles = { profiles: (raw.profiles.profiles || []).concat(borrowed) };
    var byName = {};
    function blank(name) {
      return { name: name, rosterOrder: null, role: 'Member', rank: null, power: null, week: null, total: null, login: null, dmg: null, profile: null };
    }
    (week.roster || []).forEach(function (r, i) {
      var p = byName[r.name] = blank(r.name);
      p.rosterOrder = i + 1;
      p.role = r.role || 'Member';
      p.rank = r.rank || null;
      p.power = r.power || null;
      p.week = r.week != null ? r.week : null;
      p.total = r.total || null;
      p.login = r.login || null;
    });
    (week.conquest || []).forEach(function (c) {
      var p = byName[c.name] || (byName[c.name] = blank(c.name));
      p.dmg = c.dmg || null;
    });
    (profiles.profiles || []).forEach(function (pr) {
      var p = byName[pr.name] || (byName[pr.name] = blank(pr.name));
      p.profile = pr;
      if (p.power == null) p.power = pr.power || null;
      if (p.rank == null) p.rank = (pr.badges && pr.badges.rank) || null;
    });

    var seen = {};
    var list = Object.keys(byName).map(function (k) { return byName[k]; });
    list.forEach(function (p) {
      p.power_n = parseNum(p.power);
      p.week_n = parseNum(p.week);
      p.total_n = parseNum(p.total);
      p.dmg_n = parseNum(p.dmg);
      p.login_m = loginMinutes(p.login);
      var st = (p.profile && p.profile.stats) || {};
      p.stat_n = { atk: parseNum(st.atk), def: parseNum(st.def), hp: parseNum(st.hp), spd: parseNum(st.spd) };
      var avgOf = function (arr) {
        var nums = (arr || []).map(function (x) { return parseInt(String(x).replace('+', ''), 10); }).filter(function (x) { return !isNaN(x); });
        return nums.length ? nums.reduce(function (a, b) { return a + b; }, 0) / nums.length : null;
      };
      p.stat_n.gear = avgOf(p.profile && p.profile.gear);
      p.stat_n.tech = avgOf(p.profile && p.profile.technique);
      p.stat_n.charm = avgOf(p.profile && p.profile.charm);
      var base = slugify(p.name), slug = base, n = 1;
      while (seen[slug]) slug = base + '-' + (++n);
      seen[slug] = true;
      p.slug = slug;
    });

    var first = (profiles.profiles || [])[0] || {};
    return {
      dir: dir,
      label: week.label || dir,
      capturedAt: week.capturedAt || null,
      guild: (first.badges && first.badges.guildTitle) || 'Zenith',
      server: (first.badges && first.badges.serverTitle) || null,
      players: list,
      byName: byName
    };
  }

  function prepare(current, previous) {
    var players = current.players;
    var metrics = ['power_n', 'week_n', 'total_n', 'dmg_n'];
    var max = {};
    metrics.forEach(function (m) {
      var sorted = players.slice().sort(function (a, b) { return (b[m] == null ? -1 : b[m]) - (a[m] == null ? -1 : a[m]); });
      var pos = 0;
      sorted.forEach(function (p) {
        p.pos = p.pos || {};
        p.pos[m] = p[m] == null ? null : ++pos;
      });
      max[m] = Math.max.apply(null, players.map(function (p) { return p[m] || 0; }).concat([0]));
    });
    var statMax = {};
    ['atk', 'def', 'hp', 'spd', 'gear', 'tech', 'charm'].forEach(function (k) {
      statMax[k] = Math.max.apply(null, players.map(function (p) { return p.stat_n[k] || 0; }).concat([0]));
    });
    // Standing within the player's own class, and class averages for stats.
    var statKeys = ['atk', 'def', 'hp', 'spd', 'gear', 'tech', 'charm'];
    var byClass = {};
    players.forEach(function (p) { var k = classKey(p); (byClass[k] = byClass[k] || []).push(p); });
    var classAvg = {};
    Object.keys(byClass).forEach(function (k) {
      var group = byClass[k];
      classAvg[k] = {};
      metrics.concat(statKeys).forEach(function (m) {
        var get = function (p) { return statKeys.indexOf(m) !== -1 ? p.stat_n[m] : p[m]; };
        var sorted = group.slice().sort(function (a, b) { return (get(b) == null ? -1 : get(b)) - (get(a) == null ? -1 : get(a)); });
        var pos = 0;
        sorted.forEach(function (p) {
          p.cpos = p.cpos || {};
          p.cpos[m] = get(p) == null ? null : ++pos;
          p.classSize = group.length;
        });
        var vals = group.map(get).filter(function (v) { return v != null; });
        classAvg[k][m] = vals.length ? vals.reduce(function (a, b) { return a + b; }, 0) / vals.length : null;
      });
    });

    // Growth since the previous snapshot: power gain and places climbed.
    var prevPos = {};
    if (previous) {
      previous.players.slice().sort(function (a, b) { return (b.power_n == null ? -1 : b.power_n) - (a.power_n == null ? -1 : a.power_n); })
        .forEach(function (p, i) { if (p.power_n != null) prevPos[p.name] = i + 1; });
    }
    players.forEach(function (p) {
      var prev = previous ? previous.byName[p.name] : null;
      p.delta = {
        power: fmtDelta(p.power_n, prev ? prev.power_n : null),
        total: fmtDelta(p.total_n, prev ? prev.total_n : null),
        dmg: fmtDelta(p.dmg_n, prev ? prev.dmg_n : null)
      };
      p.prev = prev || null;
      p.dmgGain = prev && prev.dmg_n != null && p.dmg_n != null ? p.dmg_n - prev.dmg_n : null;
      p.totalGain = prev && prev.total_n != null && p.total_n != null ? p.total_n - prev.total_n : null;
      p.growth = {
        power: prev && prev.power_n != null && p.power_n != null ? p.power_n - prev.power_n : null,
        places: prevPos[p.name] && p.pos.power_n ? prevPos[p.name] - p.pos.power_n : null,
        rank: null
      };
    });
    var gainers = players.filter(function (p) { return p.growth.power != null; })
      .sort(function (a, b) { return b.growth.power - a.growth.power; });
    gainers.forEach(function (p, i) { p.growth.rank = i + 1; });

    var guildAvg = {};
    metrics.concat(statKeys).forEach(function (k) {
      var vals = players.map(function (p) { return statKeys.indexOf(k) !== -1 ? p.stat_n[k] : p[k]; }).filter(function (v) { return v != null; });
      guildAvg[k] = vals.length ? vals.reduce(function (a, b) { return a + b; }, 0) / vals.length : null;
    });
    var onRoster = players.filter(function (p) { return p.rosterOrder != null; });

    var sumOf = function (list, m) { return list.reduce(function (a, p) { return a + (p[m] || 0); }, 0); };
    var sum = function (m) { return sumOf(players, m); };
    // Guild-level movement since the previous snapshot, for the summary tiles.
    var since = null;
    if (previous) {
      var on = function (snap) { return snap.players.filter(function (p) { return p.rosterOrder != null; }); };
      since = {
        power: fmtDelta(sum('power_n'), sumOf(previous.players, 'power_n')),
        dmg: fmtDelta(sum('dmg_n'), sumOf(previous.players, 'dmg_n')),
        joined: on(current).filter(function (p) { return !previous.byName[p.name]; }).length,
        left: on(previous).filter(function (p) { return !current.byName[p.name]; }).length
      };
    }
    var counts = {};
    players.forEach(function (p) { var k = classKey(p); counts[k] = (counts[k] || 0) + 1; });
    var classes = Object.keys(counts).map(function (k) {
      var sample = players.filter(function (p) { return classKey(p) === k; })[0];
      return { key: k, label: k === 'unknown' ? 'Not captured' : sample.profile['class'], count: counts[k] };
    }).sort(function (a, b) { return b.count - a.count; });
    state.meta = {
      dir: current.dir,
      classes: classes,
      classAvg: classAvg,
      guild: current.guild,
      server: current.server,
      label: current.label,
      capturedDate: fmtDay(current.dir),
      previousLabel: previous ? previous.label : null,
      sinceDays: previous ? Math.round((dirDate(current.dir) - dirDate(previous.dir)) / 86400000) : null,
      since: since,
      prevPlayers: previous ? previous.players : null,
      guildAvg: guildAvg,
      weekTop: Math.max.apply(null, onRoster.map(function (p) { return p.week_n || 0; }).concat([0])),
      weekMedian: median(onRoster.map(function (p) { return p.week_n; })),
      totalGainMedian: median(players.map(function (p) { return p.totalGain; })),
      memberCount: players.length,
      totalDmg: sum('dmg_n'),
      totalWeek: sum('week_n'),
      onlineNow: players.filter(function (p) { return p.login_m === 0; }).length,
      totalPower: sum('power_n'),
      contributing: players.filter(function (p) { return p.week_n > 0; }).length,
      active24: players.filter(function (p) { return p.login_m != null && p.login_m <= 1440; }).length,
      idle: players.filter(function (p) { return !(p.week_n > 0); }).length,
      max: max,
      statMax: statMax
    };
    state.players = players;
  }

  // ---- rendering: shared chrome ---------------------------------------------

  var CARD = 'glass rounded-2xl border border-white/70 bg-white/65 shadow-xl shadow-zinc-900/[0.06] ring-1 ring-inset ring-white/60 backdrop-blur-xl dark:border-white/10 dark:bg-zinc-900/55 dark:shadow-black/40 dark:ring-white/5';
  var MUTED = 'text-zinc-500 dark:text-zinc-400';
  var BTN = 'glass inline-flex h-9 items-center gap-1.5 rounded-lg border border-white/70 bg-white/60 px-3 text-sm font-medium shadow-md shadow-zinc-900/[0.05] backdrop-blur-md transition-colors hover:bg-white/90 active:scale-[0.98] dark:border-white/10 dark:bg-zinc-900/60 dark:hover:bg-zinc-800/80';
  var GHOST = 'inline-flex h-9 items-center gap-1.5 rounded-lg px-3 text-sm font-medium transition-colors hover:bg-white/70 dark:hover:bg-zinc-800/70';
  var BADGE = 'inline-flex items-center gap-1 rounded-md border border-zinc-200/70 bg-white/70 px-2 py-0.5 text-xs font-medium dark:border-white/10 dark:bg-zinc-800/70';
  var INPUT = 'h-9 rounded-lg border border-zinc-200/70 bg-white/70 text-sm shadow-sm transition-colors placeholder:text-zinc-400 focus:border-zinc-400 focus:bg-white focus:outline-none focus:ring-2 focus:ring-zinc-900/10 dark:border-white/10 dark:bg-zinc-800/60 dark:focus:border-zinc-600 dark:focus:bg-zinc-800 dark:focus:ring-zinc-50/10';
  var ANIM = 'stagger motion-safe:animate-fade-up';

  // Decorative character art (transparent cutouts, assets/img/art) placed in
  // otherwise empty corners on wide screens. Each slot names a piece from ART
  // or null for none.
  var ART = { blue: 'assets/img/art/pair-blue.webp', red: 'assets/img/art/pair-red.webp', group: 'assets/img/art/group.webp' };
  var DECO = { hero: 'group', dungeon: 'blue', timeline: 'red' };
  function deco(slot, cls) {
    var k = DECO[slot];
    if (!k || !ART[k]) return '';
    return '<img class="pointer-events-none select-none ' + cls + '" src="' + ART[k] + '" alt="" decoding="async">';
  }

  function setDock(html) {
    dock.innerHTML = html || '';
    dock.hidden = !html;
    app.classList.toggle('pb-24', !!html);
    app.classList.toggle('md:pb-8', !!html);
  }

  function animateMeters() {
    var bars = app.querySelectorAll('.meter > i[data-w]');
    function apply() { Array.prototype.forEach.call(bars, function (b) { b.style.width = b.getAttribute('data-w') + '%'; }); }
    if (noMotion) apply(); else requestAnimationFrame(function () { requestAnimationFrame(apply); });
  }

  function avatarUrl(pr) {
    if (!pr.file || !state.meta.dir) return null;
    return 'data/snapshots/' + (pr.snapshot || state.meta.dir) + '/avatars/' + String(pr.file).replace(/\.png$/i, '') + '.webp';
  }

  // Head-and-shoulders crop of the member's character from the capture, then
  // the class emblem. The photo hides itself when a snapshot has no avatars.
  function avatar(p, size) {
    var key = classKey(p);
    var label = key === 'unknown' ? 'Class not captured' : p.profile['class'];
    var lg = size === 'lg';
    var url = avatarUrl(p.profile || {});
    var photo = url ? '<img class="' + (lg ? 'size-16' : 'size-10') + ' shrink-0 rounded-full object-cover shadow-sm ring-2 ring-white dark:ring-zinc-800" src="' + esc(url) + '" alt="" loading="lazy" decoding="async" onerror="this.hidden=true;this.nextSibling.hidden=false">' : '';
    var inner = key === 'unknown'
      ? icon('cls-unknown', lg ? 'size-7' : 'size-4')
      : '<img class="' + (lg ? 'size-11' : 'size-7') + ' object-contain" src="assets/img/classes/' + key + '.png" alt="" loading="lazy" decoding="async">';
    var cls = '<span class="grid ' + (lg ? 'size-16' : 'size-10') + ' shrink-0 place-items-center rounded-full bg-' + key + '/10 text-' + key + ' ring-1 ring-inset ring-' + key + '/20" title="' + esc(label) + '"' + (url ? ' hidden' : '') + '>' + inner + '</span>';
    return photo + cls;
  }

  // Small class emblem inline before the class name.
  function classInline(p, extra) {
    var key = classKey(p);
    var name = key === 'unknown' ? 'Class not captured' : p.profile['class'];
    var ic = key === 'unknown' ? icon('cls-unknown', 'size-3.5') : '<img class="size-3.5 object-contain" src="assets/img/classes/' + key + '.png" alt="" loading="lazy" decoding="async">';
    return '<span class="inline-flex items-center gap-1 ' + (extra || '') + '">' + ic + esc(name) + '</span>';
  }

  // The game's Fantomon species. Players can rename theirs, so profiles carry
  // fantomonSpecies (identified from the screenshot) next to the shown name.
  var fantomonArt = ['aegiswing', 'armopi', 'boaro', 'cabbage-dog', 'chomusuke', 'falko', 'herbote', 'kels', 'luminarch-steed', 'mandragora', 'nyxarchon', 'pandarial', 'prismora', 'sylvaerie', 'terragon', 'zeioletus'];

  function fantomonSpecies(pr) {
    var sp = pr.fantomonSpecies || pr.fantomon || '';
    return fantomonArt.indexOf(slugify(sp)) === -1 ? null : sp;
  }

  function fantomonRenamed(pr) {
    var sp = fantomonSpecies(pr);
    return sp && pr.fantomon && slugify(pr.fantomon) !== slugify(sp) ? pr.fantomon : null;
  }

  function fantomonImg(pr, cls) {
    var sp = fantomonSpecies(pr);
    if (!sp) return '';
    return '<img class="' + cls + ' object-contain" src="assets/img/fantomons/' + slugify(sp) + '.png" alt="' + esc(sp) + '" loading="lazy" decoding="async">';
  }

  function shotUrl(pr) {
    if (!pr.file || !state.meta.dir) return null;
    return 'data/snapshots/' + (pr.snapshot || state.meta.dir) + '/shots/' + String(pr.file).replace(/\.png$/i, '') + '.webp';
  }

  function shotThumb(p) {
    var url = shotUrl(p.profile || {});
    if (!url) return '';
    return '<button type="button" class="group relative block h-24 w-[68px] shrink-0 overflow-hidden rounded-lg ring-1 ring-black/10 transition-transform duration-500 ease-[cubic-bezier(0.32,0.72,0,1)] hover:-translate-y-0.5 focus:outline-none focus-visible:ring-2 focus-visible:ring-zinc-900 dark:ring-white/15" data-shot="' + esc(url) + '" data-shot-name="' + esc(p.name) + '" title="View the in-game capture">' +
      '<img class="h-full w-full object-cover object-top" src="' + esc(url) + '" alt="In-game profile capture of ' + esc(p.name) + '" loading="lazy" decoding="async" onerror="this.parentNode.hidden=true">' +
      '<span class="absolute inset-x-0 bottom-0 bg-gradient-to-t from-zinc-950/70 to-transparent px-1 pb-1 pt-4 text-center text-[10px] font-medium text-white">Capture</span></button>';
  }

  function bindShots() {
    var box = document.getElementById('lightbox'), img = document.getElementById('lightbox-img'), cap = document.getElementById('lightbox-cap');
    function close() { box.hidden = true; img.src = ''; document.body.classList.remove('overflow-hidden'); }
    Array.prototype.forEach.call(app.querySelectorAll('[data-shot]'), function (b) {
      b.addEventListener('click', function () {
        img.src = b.getAttribute('data-shot');
        cap.textContent = b.getAttribute('data-shot-name') + ', in-game profile at capture';
        box.hidden = false;
        document.body.classList.add('overflow-hidden');
        document.getElementById('lightbox-close').focus();
      });
    });
    if (!box.dataset.bound) {
      box.dataset.bound = '1';
      box.addEventListener('click', function (ev) { if (ev.target === box || ev.target.id === 'lightbox-close' || ev.target.closest('#lightbox-close')) close(); });
      document.addEventListener('keydown', function (ev) { if (ev.key === 'Escape' && !box.hidden) close(); });
    }
  }

  var CLASS_BADGE = 'inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-xs font-medium';

  function classBadge(p, text) {
    var k = classKey(p);
    return '<span class="' + CLASS_BADGE + ' border-' + k + '/30 bg-' + k + '/10 text-' + k + '">' + icon('cls-' + k, 'size-3') + text + '</span>';
  }

  function growthBadge(ic, text) {
    return '<span class="' + CLASS_BADGE + ' border-violet-200 bg-violet-50 text-violet-700 dark:border-violet-800 dark:bg-violet-950/40 dark:text-violet-300">' + icon(ic, 'size-3') + text + '</span>';
  }

  // Standing within the class for the ranking metrics, best first.
  function classBadges(p) {
    var k = classKey(p), out = [];
    if (k === 'unknown' || !p.cpos) return out;
    var cls = p.profile['class'];
    [['power_n', 'power'], ['dmg_n', 'Conquest damage'], ['total_n', 'total contribution'], ['week_n', 'weekly contribution']].forEach(function (m) {
      var pos = p.cpos[m[0]];
      if (pos === 1 && p.classSize >= 2) out.push(classBadge(p, 'Best ' + esc(cls) + ' by ' + m[1]));
      else if (pos != null && pos <= 3 && p.classSize >= 4) out.push(classBadge(p, 'Top 3 ' + esc(cls) + ' by ' + m[1]));
    });
    return out;
  }

  // Growth since the previous snapshot. Empty until a second snapshot exists.
  function growthBadges(p) {
    var out = [], g = p.growth;
    if (!g || g.power == null) return out;
    if (g.rank === 1 && g.power > 0) out.push(growthBadge('up', 'Most improved power'));
    else if (g.rank != null && g.rank <= 3 && g.power > 0) out.push(growthBadge('up', 'Top 3 power gain'));
    if (g.places != null && g.places >= 3) out.push(growthBadge('trophy', 'Climbed ' + g.places + ' places'));
    return out;
  }

  function fantomonBadge(pr) {
    var sp = fantomonSpecies(pr), renamed = fantomonRenamed(pr);
    if (!sp && !pr.fantomon) return '';
    return '<span class="' + BADGE + '">' + icon('fantomon', 'size-3 text-red-500') + esc(sp || pr.fantomon) +
      (renamed ? ' <span class="' + MUTED + '">"' + esc(renamed) + '"</span>' : '') + '</span>';
  }

  function roleBadge(p) {
    if (p.role === 'Leader') return '<span class="' + BADGE + ' text-amber-700 dark:text-amber-400">' + icon('crown', 'size-3') + 'Leader</span>';
    if (p.role === 'Deputy') return '<span class="' + BADGE + ' text-violet-700 dark:text-violet-400">' + icon('star', 'size-3') + 'Deputy</span>';
    return '';
  }

  function posBadge(pos) {
    var tone = pos === 1 ? 'bg-amber-100 text-amber-800 dark:bg-amber-500/15 dark:text-amber-300'
      : pos === 2 ? 'bg-zinc-200 text-zinc-700 dark:bg-zinc-700 dark:text-zinc-200'
      : pos === 3 ? 'bg-orange-100 text-orange-800 dark:bg-orange-500/15 dark:text-orange-300' : '';
    if (!tone) return '<span class="' + MUTED + '">' + pos + '</span>';
    return '<span class="inline-flex size-6 items-center justify-center rounded-full text-xs font-semibold ' + tone + '">' + pos + '</span>';
  }

  // ---- top bar ---------------------------------------------------------------
  // Fixed tabs for the main views plus the snapshot picker. A player profile
  // counts as part of Rankings.

  var TABS = [['', 'Dashboard', 'grid'], ['rankings', 'Rankings', 'trophy'], ['timeline', 'Timeline', 'clock']];

  function renderNav(slug) {
    var active = slug === '' || slug === 'timeline' ? slug : 'rankings';
    var html = '<div class="mx-auto flex max-w-6xl flex-wrap items-center gap-x-4 px-4 sm:px-6 lg:flex-nowrap">' +
      '<a class="flex h-12 shrink-0 items-center gap-2 lg:h-14" href="' + esc(link('')) + '" aria-label="' + esc(state.meta.guild) + ' dashboard"><img class="size-7 rounded-md" src="assets/img/logo/zenith-64.webp" alt="">' +
      '<span class="hidden font-semibold tracking-tight sm:inline">' + esc(state.meta.guild) + '</span></a>' +
      '<nav class="order-last flex basis-full gap-1 pb-2 lg:order-none lg:basis-auto lg:pb-0" aria-label="Sections">';
    TABS.forEach(function (t) {
      var on = t[0] === active;
      html += '<a class="inline-flex h-9 flex-1 items-center justify-center gap-1.5 rounded-lg px-3 text-sm font-medium transition-colors lg:flex-none ' +
        (on ? 'bg-zinc-900 text-white dark:bg-zinc-50 dark:text-zinc-900' : 'text-zinc-600 hover:bg-zinc-900/5 dark:text-zinc-300 dark:hover:bg-white/10') +
        '" href="' + esc(link(t[0])) + '"' + (on ? ' aria-current="page"' : '') + '>' + icon(t[2], 'size-4') + t[1] + '</a>';
    });
    html += '</nav><div class="ml-auto flex items-center gap-2">' + (slug === 'timeline' ? '' : snapPicker(slug)) +
      '<a class="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-lg bg-[#5865F2] px-3 text-sm font-semibold text-white shadow-md transition-colors hover:bg-[#4752C4]" href="https://discord.gg/fapjXcFYhw" target="_blank" rel="noopener" aria-label="Join the Discord">' +
      icon('discord', 'size-4') + '<span class="sm:hidden">Join</span><span class="hidden sm:inline">Join the Discord</span></a></div></div>';
    topbar.innerHTML = html;
    bindPicker();
  }

  // ---- snapshot picker --------------------------------------------------------
  // Steps to the older or newer snapshot, with a month calendar in a popover
  // where the days that have a snapshot are links. It sits in the top bar; slug
  // keeps the current view open across the switch.

  function snapPicker(slug, extra) {
    var dirs = state.dirs, at = dirs.indexOf(state.meta.dir);
    var seg = 'grid w-9 shrink-0 place-items-center transition-colors';
    var shown = fmtDay(state.meta.dir), cut = shown.lastIndexOf(' ');
    function step(dir, ic, label) {
      if (!dir) return '<span class="' + seg + ' opacity-35" aria-hidden="true">' + icon(ic, 'size-4') + '</span>';
      return '<a class="' + seg + ' hover:bg-white/90 dark:hover:bg-zinc-800/80" href="' + esc(link(slug, dir)) + '" title="' + label + ', ' + esc(fmtDay(dir)) + '" aria-label="' + label + ', ' + esc(fmtDay(dir)) + '">' + icon(ic, 'size-4') + '</a>';
    }
    return '<div class="relative text-zinc-900 dark:text-zinc-50 ' + (extra || '') + '" data-picker data-slug="' + esc(slug || '') + '">' +
      '<div class="glass flex h-9 items-stretch divide-x divide-zinc-900/10 overflow-hidden rounded-lg border border-white/70 bg-white/60 text-sm font-medium shadow-md shadow-zinc-900/[0.05] backdrop-blur-md dark:divide-white/10 dark:border-white/10 dark:bg-zinc-900/60">' +
      step(at > 0 ? dirs[at - 1] : null, 'back', 'Older snapshot') +
      '<button type="button" class="inline-flex min-w-0 flex-1 items-center justify-center gap-1.5 whitespace-nowrap px-3 transition-colors hover:bg-white/90 dark:hover:bg-zinc-800/80" aria-haspopup="dialog" aria-expanded="false" data-picker-toggle>' +
      icon('calendar', 'size-4') + '<span class="sr-only">Snapshot date, </span><span>' + esc(shown.slice(0, cut)) + '<span class="sr-only sm:not-sr-only">' + esc(shown.slice(cut)) + '</span></span>' + icon('down', 'size-3.5 opacity-60') + '</button>' +
      step(at < dirs.length - 1 ? dirs[at + 1] : null, 'next', 'Newer snapshot') + '</div>' +
      '<div class="absolute right-0 top-full z-30 mt-2 w-72 rounded-2xl border border-zinc-200 bg-white p-3 shadow-2xl shadow-zinc-900/20 motion-safe:animate-fade-in dark:border-zinc-700 dark:bg-zinc-900 dark:shadow-black/60" role="dialog" aria-label="Choose a snapshot date" hidden data-picker-pop></div></div>';
  }

  function calendarHTML(y, mo, slug) {
    var dirs = state.dirs, first = dirDate(dirs[0]), last = dirDate(dirs[dirs.length - 1]);
    var idx = y * 12 + mo, now = new Date();
    var navBtn = 'grid size-8 place-items-center rounded-lg transition-colors hover:bg-zinc-100 disabled:pointer-events-none disabled:opacity-30 dark:hover:bg-zinc-800';
    var html = '<div class="flex items-center justify-between gap-2">' +
      '<button type="button" class="' + navBtn + '" data-cal="-1" aria-label="Previous month"' + (idx > first.getFullYear() * 12 + first.getMonth() ? '' : ' disabled') + '>' + icon('back', 'size-4') + '</button>' +
      '<p class="text-sm font-semibold" aria-live="polite">' + esc(new Date(y, mo, 1).toLocaleDateString('en-GB', { month: 'long', year: 'numeric' })) + '</p>' +
      '<button type="button" class="' + navBtn + '" data-cal="1" aria-label="Next month"' + (idx < last.getFullYear() * 12 + last.getMonth() ? '' : ' disabled') + '>' + icon('next', 'size-4') + '</button></div>' +
      '<div class="mt-2 grid grid-cols-7 justify-items-center gap-y-1 text-center text-sm">';
    ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'].forEach(function (d) { html += '<span class="pb-1 text-[11px] font-medium ' + MUTED + '">' + d + '</span>'; });
    var lead = (new Date(y, mo, 1).getDay() + 6) % 7, days = new Date(y, mo + 1, 0).getDate();
    for (var k = 0; k < lead; k++) html += '<span></span>';
    var cell = 'grid size-9 place-items-center rounded-full ';
    for (var d = 1; d <= days; d++) {
      var dir = y + '-' + pad2(mo + 1) + '-' + pad2(d);
      var today = now.getFullYear() === y && now.getMonth() === mo && now.getDate() === d;
      if (dirs.indexOf(dir) === -1) {
        html += '<span class="' + cell + 'text-zinc-400 dark:text-zinc-600' + (today ? ' ring-1 ring-inset ring-emerald-500/60' : '') + '"' + (today ? ' title="Today"' : '') + '>' + d + '</span>';
      } else {
        var cur = dir === state.meta.dir;
        html += '<a class="' + cell + 'font-semibold transition-colors ' + (cur ? 'bg-zinc-900 text-white dark:bg-zinc-50 dark:text-zinc-900' : 'bg-violet-100 text-violet-800 hover:bg-violet-200 dark:bg-violet-500/20 dark:text-violet-200 dark:hover:bg-violet-500/30') +
          '" href="' + esc(link(slug, dir)) + '"' + (cur ? ' aria-current="date"' : '') + ' title="Snapshot from ' + esc(fmtDay(dir)) + '" aria-label="Snapshot from ' + esc(fmtDay(dir)) + (cur ? ', showing' : '') + '">' + d + '</a>';
      }
    }
    html += '</div><div class="mt-3 flex items-center justify-between gap-2 border-t border-zinc-200/70 pt-3 text-xs ' + MUTED + ' dark:border-white/10">' +
      '<span class="inline-flex items-center gap-1.5"><i class="size-2.5 rounded-full bg-violet-400"></i>' + dirs.length + (dirs.length === 1 ? ' snapshot' : ' snapshots') + '</span>' +
      (state.meta.dir === state.latest ? '<span>Showing the latest</span>' : '<a class="font-semibold text-zinc-900 underline underline-offset-2 dark:text-zinc-50" href="' + esc(link(slug, state.latest)) + '">Jump to latest</a>') +
      '</div>';
    return html;
  }

  function closePicker(focus) {
    var root = topbar.querySelector('[data-picker]');
    if (!root) return;
    var pop = root.querySelector('[data-picker-pop]'), btn = root.querySelector('[data-picker-toggle]');
    if (pop.hidden) return;
    pop.hidden = true;
    btn.setAttribute('aria-expanded', 'false');
    if (focus) btn.focus();
  }

  function bindPicker() {
    var root = topbar.querySelector('[data-picker]');
    if (!root) return;
    var btn = root.querySelector('[data-picker-toggle]'), pop = root.querySelector('[data-picker-pop]');
    var slug = root.getAttribute('data-slug'), y, mo;
    function draw() { pop.innerHTML = calendarHTML(y, mo, slug); }
    btn.addEventListener('click', function () {
      if (!pop.hidden) { closePicker(); return; }
      var cur = dirDate(state.meta.dir);
      y = cur.getFullYear(); mo = cur.getMonth();
      draw();
      pop.hidden = false;
      btn.setAttribute('aria-expanded', 'true');
    });
    pop.addEventListener('click', function (ev) {
      var nav = ev.target.closest('[data-cal]');
      if (nav) {
        var to = new Date(y, mo + parseInt(nav.getAttribute('data-cal'), 10), 1);
        y = to.getFullYear(); mo = to.getMonth();
        draw();
        var again = pop.querySelector('[data-cal="' + nav.getAttribute('data-cal') + '"]');
        (again && !again.disabled ? again : pop.querySelector('[data-cal]:not([disabled])') || btn).focus();
      } else if (ev.target.closest('a')) closePicker();
    });
    if (!document.documentElement.dataset.pickerBound) {
      document.documentElement.dataset.pickerBound = '1';
      // composedPath, because redrawing a month detaches the clicked button.
      document.addEventListener('click', function (ev) {
        var open = topbar.querySelector('[data-picker]');
        if (open && ev.composedPath().indexOf(open) === -1) closePicker();
      });
      document.addEventListener('keydown', function (ev) { if (ev.key === 'Escape') closePicker(true); });
    }
  }

  // Shown above any view of a snapshot that is not the latest one.
  function pastNotice(slug) {
    var m = state.meta;
    if (m.dir === state.latest) return '';
    return '<p class="glass mb-4 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl border border-amber-300/70 bg-amber-50/90 px-4 py-2.5 text-sm text-amber-900 shadow-md shadow-zinc-900/[0.05] backdrop-blur-md dark:border-amber-500/30 dark:bg-amber-950/70 dark:text-amber-100 ' + ANIM + '" style="--i:0">' +
      icon('clock', 'size-4') + '<span class="min-w-0 flex-1 basis-56">You are viewing an older snapshot: ' + esc(m.label) + ', ' + esc(m.capturedDate) + '.</span>' +
      '<a class="font-semibold underline underline-offset-2" href="' + esc(link(slug, state.latest)) + '">Go to the latest, ' + esc(fmtDay(state.latest)) + '</a></p>';
  }

  // ---- rendering: rankings --------------------------------------------------

  var sorts = [
    { key: 'power_n', label: 'Power', type: 'num' },
    { key: 'week_n', label: 'Weekly contribution', type: 'num' },
    { key: 'total_n', label: 'Total contribution', type: 'num' },
    { key: 'dmg_n', label: 'Conquest damage', type: 'num' },
    { key: 'name', label: 'Player', type: 'text' }
  ];

  function sortDef(key) {
    return sorts.filter(function (c) { return c.key === key; })[0];
  }

  function sortedPlayers() {
    var key = state.sortKey, dir = state.sortDir === 'asc' ? 1 : -1;
    var col = sortDef(key);
    var list = state.players.slice();
    list.sort(function (a, b) {
      if (col.type === 'num') {
        var av = a[key] == null ? (key === 'login_m' ? 1e9 : -1) : a[key];
        var bv = b[key] == null ? (key === 'login_m' ? 1e9 : -1) : b[key];
        if (av !== bv) return (av - bv) * dir;
        return ((b.total_n || 0) - (a.total_n || 0));
      }
      return String(a[key]).localeCompare(String(b[key]), undefined, { sensitivity: 'base' }) * dir;
    });
    return list;
  }

  function setSort(key) {
    if (state.sortKey === key) {
      state.sortDir = state.sortDir === 'asc' ? 'desc' : 'asc';
    } else {
      state.sortKey = key;
      state.sortDir = key === 'login_m' || key === 'name' ? 'asc' : 'desc';
    }
  }

  function kpi(ic, value, label, i, hint) {
    var n = typeof value === 'number' ? value : parseNum(value);
    return '<div class="' + CARD + ' flex items-center gap-3 px-4 py-3 ' + ANIM + '" style="--i:' + i + '">' +
      '<span class="grid size-9 shrink-0 place-items-center rounded-lg bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">' + icon(ic, 'size-4') + '</span>' +
      '<div class="min-w-0 flex-1"><p class="text-xs font-medium ' + MUTED + '">' + label + '</p>' +
      '<p class="flex flex-wrap items-baseline gap-x-2"><span class="text-xl font-semibold tracking-tight"' + (n != null ? ' data-count="' + n + '"' : '') + '>' + esc(value) + '</span>' +
      (hint ? '<span class="whitespace-nowrap text-xs ' + MUTED + '">' + esc(hint) + '</span>' : '') + '</p></div></div>';
  }

  function renderDashboard() {
    var m = state.meta, since = m.since;
    var html = pastNotice('') + '<section class="mb-6 flex flex-wrap items-center gap-4 sm:gap-5 ' + ANIM + '" style="--i:0" aria-label="Guild">' +
      '<img class="size-16 shrink-0 rounded-xl shadow-lg ring-1 ring-black/5 sm:size-20 dark:ring-white/10" src="assets/img/logo/zenith-160.webp" alt="" decoding="async">' +
      '<div class="min-w-0 flex-1"><p class="text-xs font-medium uppercase tracking-wide ' + MUTED + '">Sword x Staff guild on ' + esc(m.server || 'an unknown server') + '</p>' +
      '<h1 class="mt-0.5 text-3xl font-semibold tracking-tight sm:text-4xl">' + esc(m.guild) + '</h1>' +
      '<p class="mt-1 text-sm ' + MUTED + '">' + esc(m.memberCount + ' members. ' + m.label + ', captured ' + m.capturedDate + '.') + '</p></div>' +
      deco('hero', 'hidden h-36 w-auto -my-4 mr-2 self-end lg:block') +
      '</section>';
    html += '<section class="grid grid-cols-1 gap-3 sm:grid-cols-2 sm:gap-4 lg:grid-cols-4" aria-label="Guild summary">' +
      kpi('people', m.memberCount, 'Members', 1, since && (since.joined || since.left) ? since.joined + ' joined, ' + since.left + ' left' : '') +
      kpi('bolt', fmtNum(m.totalPower), 'Total power', 2, since && since.power ? since.power + ' since ' + m.previousLabel : '') +
      kpi('gem', fmtNum(m.totalWeek), 'Weekly contribution', 3) +
      kpi('swords', fmtNum(m.totalDmg), 'Conquest damage', 4, since && since.dmg ? since.dmg + ' since ' + m.previousLabel : '') +
      '</section>';
    html += '<div class="mt-4 grid gap-3 sm:gap-4 md:grid-cols-2" id="coming-up"></div>';

    var heading = function (id, title, note) {
      return '<div class="mb-3 mt-8 flex flex-wrap items-baseline justify-between gap-2"><h2 class="text-sm font-semibold" id="' + id + '">' + title + '</h2><p class="text-xs ' + MUTED + '">' + note + '</p></div>';
    };
    if (m.prevPlayers) {
      html += '<section aria-labelledby="movers-title">' + heading('movers-title', 'Top gains since ' + esc(m.previousLabel), 'Who grew the most. Members who are in both snapshots, ' + m.sinceDays + (m.sinceDays === 1 ? ' day' : ' days') + ' apart.') + moversSection(7) + '</section>';
      var mvps = mvpSection(10);
      if (mvps) html += '<section aria-labelledby="mvp-title">' + heading('mvp-title', 'Class MVPs since ' + esc(m.previousLabel), 'The best all-rounder in each class: average rank among classmates for power, upgrade levels, contribution and Conquest damage gained.') + mvps + '</section>';
    }
    html += '<section aria-labelledby="overview-title">' + heading('overview-title', 'Guild stats', m.prevPlayers ? 'How the guild is built and where it stands.' : 'Top gains and growth appear once there is an earlier snapshot to compare with.') +
      (m.prevPlayers ? '<div class="mb-4">' + growthCard(10) + '</div>' : '') +
      '<div class="grid gap-4 lg:grid-cols-2">' + classCard(11) + concentrationCard(12) +
      '<div class="empty:hidden" id="guild-readiness">' + (timeline ? guildReadinessCard(timeline, 13) : '') + '</div>' +
      contributionHealthCard(14) + '</div>' +
      '<div class="mt-4 grid gap-4 lg:grid-cols-3"><div class="min-w-0 lg:col-span-2">' + recordsCard(14) + '</div>' + fantomonCard(14) + '</div></section>';

    app.innerHTML = html;
    Array.prototype.forEach.call(app.querySelectorAll('[data-count]'), function (el) {
      countUp(el, parseFloat(el.getAttribute('data-count')), el.textContent);
    });
    animateMeters();
    loadTimeline().then(function (t) {
      if (state.meta !== m) return;
      var box = document.getElementById('coming-up'), ready = document.getElementById('guild-readiness');
      if (box) box.innerHTML = comingUp(t, 3);
      if (ready && !ready.innerHTML) ready.innerHTML = guildReadinessCard(t, 13);
      animateMeters();
    }).catch(function () {});
    document.title = m.guild + ' dashboard' + (m.dir === state.latest ? '' : ', ' + m.capturedDate);
  }

  function renderRankings() {
    var m = state.meta;
    var html = pastNotice('rankings');
    html += '<section class="' + CARD + ' ' + ANIM + '" style="--i:1" aria-labelledby="ledger-title">' +
      '<div class="flex flex-col gap-3 border-b border-zinc-200/70 p-4 sm:flex-row sm:items-center sm:justify-between sm:p-5 dark:border-white/10">' +
      '<div><h1 class="text-base font-semibold" id="ledger-title">Guild rankings</h1>' +
      '<p class="text-sm ' + MUTED + '">Click a column to sort. Open a row for the full profile.</p></div>' +
      '<div class="flex gap-2">' +
      '<label class="relative flex-1 sm:w-60 sm:flex-none">' + icon('search', 'pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 ' + MUTED) +
      '<input type="search" id="find" class="' + INPUT + ' w-full pl-9 pr-3" placeholder="Find a player" aria-label="Find a player" autocomplete="off" spellcheck="false" value="' + esc(state.query) + '"></label>' +
      '<select id="sort-select" class="' + INPUT + ' w-auto px-3 md:hidden" aria-label="Sort by">';
    sorts.forEach(function (s) {
      html += '<option value="' + s.key + '"' + (s.key === state.sortKey ? ' selected' : '') + '>' + esc(s.label) + '</option>';
    });
    html += '</select></div></div>' +
      '<div class="flex gap-1.5 overflow-x-auto border-b border-zinc-200/70 px-4 py-2.5 sm:px-5 dark:border-white/10" id="class-filter" role="group" aria-label="Filter by class"></div>' +
      '<div class="overflow-x-auto"><table class="w-full text-sm">' +
      '<thead class="text-xs ' + MUTED + '"><tr class="border-b border-zinc-200/70 dark:border-white/10" id="ranks-head"></tr></thead>' +
      '<tbody class="divide-y divide-zinc-200/60 dark:divide-white/5" id="ranks-body"></tbody></table></div>' +
      '<p class="p-6 text-center text-sm ' + MUTED + '" id="empty" hidden>No player matches that search and class filter.</p></section>';

    app.innerHTML = html;
    renderFilter();
    renderHead();
    renderRows();

    document.getElementById('find').addEventListener('input', function () {
      state.query = this.value.trim().toLowerCase();
      renderRows();
    });
    document.getElementById('sort-select').addEventListener('change', function () {
      state.sortKey = this.value;
      state.sortDir = this.value === 'login_m' || this.value === 'name' ? 'asc' : 'desc';
      renderHead(); renderRows();
    });
    document.getElementById('ranks-body').addEventListener('click', function (ev) {
      var tr = ev.target.closest('tr[data-href]');
      if (!tr || ev.target.closest('a')) return;
      location.hash = tr.getAttribute('data-href');
    });

    document.title = m.guild + ' rankings' + (m.dir === state.latest ? '' : ', ' + m.capturedDate);
  }

  function renderFilter() {
    var box = document.getElementById('class-filter'), m = state.meta;
    var base = 'inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full border px-3 text-xs font-medium transition-colors ';
    var off = 'border-zinc-200/70 bg-white/60 text-zinc-600 hover:bg-white dark:border-white/10 dark:bg-zinc-800/60 dark:text-zinc-300 dark:hover:bg-zinc-800';
    var on = 'border-zinc-900 bg-zinc-900 text-white dark:border-zinc-50 dark:bg-zinc-50 dark:text-zinc-900';
    var html = '<button type="button" data-class="" aria-pressed="' + (state.classFilter == null) + '" class="' + base + (state.classFilter == null ? on : off) + '">All <span class="opacity-60">' + m.memberCount + '</span></button>';
    m.classes.forEach(function (c) {
      var active = state.classFilter === c.key;
      html += '<button type="button" data-class="' + c.key + '" aria-pressed="' + active + '" class="' + base + (active ? on : off) + '">' +
        (c.key === 'unknown' ? icon('cls-unknown', 'size-3.5') : '<img class="size-4 object-contain" src="assets/img/classes/' + c.key + '.png" alt="">') +
        esc(c.label) + ' <span class="opacity-60">' + c.count + '</span></button>';
    });
    box.innerHTML = html;
    Array.prototype.forEach.call(box.querySelectorAll('button'), function (btn) {
      btn.addEventListener('click', function () {
        state.classFilter = btn.getAttribute('data-class') || null;
        renderFilter(); renderRows();
      });
    });
  }

  var columns = [
    { key: 'name', label: 'Player', cls: 'text-left' },
    { key: 'mobile', label: '', cls: 'text-right md:hidden' },
    { key: 'power_n', label: 'Power', cls: 'hidden text-right md:table-cell' },
    { key: 'week_n', label: 'Weekly contribution', cls: 'hidden text-right md:table-cell' },
    { key: 'total_n', label: 'Total contribution', cls: 'hidden text-right md:table-cell' },
    { key: 'dmg_n', label: 'Conquest damage', cls: 'hidden text-right md:table-cell' }
  ];

  var metrics = { power_n: ['Power', 'power', 'Power'], week_n: ['Weekly contribution', 'week', 'Weekly'], total_n: ['Total contribution', 'total', 'Total'], dmg_n: ['Conquest damage', 'dmg', 'Conquest'] };

  function mobileKey() {
    return metrics[state.sortKey] ? state.sortKey : 'power_n';
  }

  function renderHead() {
    var head = document.getElementById('ranks-head');
    var html = '<th scope="col" class="w-12 px-4 py-3 text-left font-medium">#</th>';
    columns.forEach(function (c) {
      var key = c.key === 'mobile' ? mobileKey() : c.key;
      var label = c.key === 'mobile' ? metrics[key][0] : c.label;
      var active = key === state.sortKey;
      var ic = active ? (state.sortDir === 'asc' ? 'up' : 'down') : 'updown';
      html += '<th scope="col" class="px-4 py-3 font-medium ' + c.cls + '"' + (active ? ' aria-sort="' + (state.sortDir === 'asc' ? 'ascending' : 'descending') + '"' : '') + '>' +
        '<button type="button" data-key="' + key + '" class="inline-flex items-center gap-1 rounded transition-colors hover:text-zinc-900 dark:hover:text-zinc-50' + (active ? ' text-zinc-900 dark:text-zinc-50' : '') + '">' +
        esc(label) + icon(ic, 'size-3.5' + (active ? '' : ' opacity-50')) + '</button></th>';
    });
    head.innerHTML = html;
    Array.prototype.forEach.call(head.querySelectorAll('button[data-key]'), function (btn) {
      btn.addEventListener('click', function () {
        setSort(btn.getAttribute('data-key'));
        var sel = document.getElementById('sort-select');
        if (sel) sel.value = state.sortKey;
        renderHead(); renderRows();
      });
    });
  }

  function num(p, key, raw, extra) {
    var active = key === state.sortKey;
    var cls = 'px-4 py-3 tabular-nums ' + (extra || '') + (active ? ' font-semibold text-zinc-900 dark:text-zinc-50' : ' text-zinc-700 dark:text-zinc-300');
    if (raw == null) return '<td class="' + cls + ' ' + MUTED + '">-</td>';
    if (key === 'week_n' && !(p.week_n > 0)) cls += ' text-red-600 dark:text-red-400';
    return '<td class="' + cls + '">' + esc(raw) + '</td>';
  }

  function renderRows() {
    var body = document.getElementById('ranks-body');
    var list = sortedPlayers(), q = state.query;
    var shown = 0, html = '', mk = mobileKey();
    list.forEach(function (p) {
      if (q && p.name.toLowerCase().indexOf(q) === -1) return;
      if (state.classFilter && classKey(p) !== state.classFilter) return;
      shown++;
      var sub = '';
      Object.keys(metrics).forEach(function (k) {
        if (k === mk) return;
        var raw = p[metrics[k][1]];
        sub += '<span class="md:hidden">' + metrics[k][2] + ' <b class="font-medium text-zinc-700 dark:text-zinc-300">' + esc(raw != null ? raw : '-') + '</b></span>';
      });
      html += '<tr class="group cursor-pointer transition-colors hover:bg-white/60 dark:hover:bg-white/5" data-href="' + esc(link(p.slug)) + '">' +
        '<td class="px-3 py-3 sm:px-4">' + posBadge(shown) + '</td>' +
        '<td class="px-3 py-3 sm:px-4"><div class="flex items-center gap-3">' + avatar(p) +
        '<div class="min-w-0"><div class="flex items-center gap-2"><a class="truncate font-medium text-zinc-900 hover:underline dark:text-zinc-50" href="' + esc(link(p.slug)) + '">' + esc(p.name) + '</a>' + roleBadge(p) + '</div>' +
        '<div class="flex flex-wrap items-center gap-x-3 text-xs ' + MUTED + '">' + classInline(p) +
        (p.rank ? '<span class="hidden sm:inline">' + esc(p.rank) + '</span>' : '') +
        sub + '</div></div></div></td>' +
        num(p, mk, p[metrics[mk][1]], 'text-right md:hidden') +
        num(p, 'power_n', p.power, 'hidden text-right md:table-cell') +
        num(p, 'week_n', p.week, 'hidden text-right md:table-cell') +
        num(p, 'total_n', p.total, 'hidden text-right md:table-cell') +
        num(p, 'dmg_n', p.dmg, 'hidden text-right md:table-cell') +
        '</tr>';
    });
    body.innerHTML = html;
    document.getElementById('empty').hidden = shown > 0;
  }

  // ---- rendering: guild overview ----------------------------------------------
  // Dashboard cards about the guild as a whole. Anything that compares with the
  // previous snapshot only counts members who are in both.

  function moversCard(i, title, sub, rows) {
    var body = '<ol class="mt-3 divide-y divide-zinc-200/60 dark:divide-white/5">';
    rows.forEach(function (r, k) {
      body += '<li class="flex items-center gap-3 py-2 text-sm"><span class="w-5 shrink-0 text-center text-xs tabular-nums ' + MUTED + '">' + (k + 1) + '</span>' + avatar(r.p) +
        '<div class="min-w-0 flex-1"><a class="block truncate font-medium hover:underline" href="' + esc(link(r.p.slug)) + '">' + esc(r.p.name) + '</a>' +
        '<p class="truncate text-xs ' + MUTED + '">' + esc(r.sub) + '</p></div>' +
        '<span class="shrink-0 text-sm font-semibold tabular-nums text-emerald-600 dark:text-emerald-400">' + esc(r.value) + '</span></li>';
    });
    if (!rows.length) body += '<li class="py-3 text-sm ' + MUTED + '">Nobody moved on this one.</li>';
    return insightCard(i, title, sub, '', body + '</ol>');
  }

  // Upgrade levels added across the named slot groups since the earlier profile
  // capture, or null for a member without a capture in both snapshots.
  function levelsAdded(p, keys) {
    var was = prevProfile(p);
    if (!was) return null;
    var sum = function (arr) { return (arr || []).reduce(function (a, v) { var n = intOf(v); return a + (n == null ? 0 : n); }, 0); };
    return keys.reduce(function (a, k) { return a + sum(p.profile[k]) - sum(was[k]); }, 0);
  }

  // One MVP per class: the best average placing among classmates across what
  // was gained since the previous snapshot. Judging within the class keeps
  // support classes from being measured against damage dealers.
  var MVP_METRICS = [
    ['power', function (p) { return p.growth.power; }, function (v) { return '+' + fmtNum(v) + ' power'; }],
    ['upgrades', function (p) { return levelsAdded(p, ['gear', 'technique', 'charm']); }, function (v) { return '+' + v + ' upgrade levels'; }],
    ['contribution', function (p) { return p.totalGain; }, function (v) { return '+' + fmtNum(v) + ' contribution'; }],
    ['damage', function (p) { return p.dmgGain; }, function (v) { return '+' + fmtNum(v) + ' damage'; }]
  ];

  function classMvps() {
    var out = [];
    state.meta.classes.forEach(function (c) {
      if (c.key === 'unknown') return;
      var group = state.players.filter(function (p) { return p.prev && classKey(p) === c.key; });
      if (group.length < 2) return;
      var scored = group.map(function (p) { return { p: p, places: [], total: 0, n: 0 }; });
      MVP_METRICS.forEach(function (mt) {
        var vals = group.map(mt[1]);
        scored.forEach(function (s, k) {
          if (vals[k] == null) { s.places.push(null); return; }
          // Ties share a place: one more than the number of classmates who did better.
          var place = 1 + vals.filter(function (v) { return v != null && v > vals[k]; }).length;
          s.places.push({ place: place, value: vals[k] });
          s.total += place; s.n++;
        });
      });
      scored = scored.filter(function (s) { return s.n >= 2; }).sort(function (a, b) {
        return a.total / a.n - b.total / b.n || (b.p.growth.power || 0) - (a.p.growth.power || 0);
      });
      if (scored.length) out.push({ cls: c, size: group.length, mvp: scored[0], runnerUp: scored[1] || null });
    });
    return out;
  }

  function mvpSection(i) {
    var list = classMvps();
    if (!list.length) return '';
    var html = '<div class="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">';
    list.forEach(function (x, k) {
      var p = x.mvp.p;
      var body = '<div class="mt-4 flex items-center gap-3">' + avatar(p, 'lg') + '<div class="min-w-0"><a class="block truncate text-lg font-semibold tracking-tight hover:underline" href="' + esc(link(p.slug)) + '">' + esc(p.name) + '</a>' +
        '<p class="text-xs ' + MUTED + '">Avg rank ' + (Math.round(10 * x.mvp.total / x.mvp.n) / 10) + ' among ' + x.size + ' ' + esc(x.cls.label) + 's</p></div></div>' +
        '<ul class="mt-4 space-y-1.5 text-sm">';
      MVP_METRICS.forEach(function (mt, j) {
        var r = x.mvp.places[j];
        if (!r) return;
        body += '<li class="flex items-baseline justify-between gap-3"><span class="min-w-0 truncate">' + esc(mt[2](r.value)) + '</span>' +
          '<span class="shrink-0 text-xs tabular-nums ' + (r.place === 1 ? 'font-semibold text-zinc-900 dark:text-zinc-50' : MUTED) + '">' + ordinal(r.place) + ' in class</span></li>';
      });
      body += '</ul>';
      if (x.runnerUp) body += cardFoot('Runner-up: <a class="font-medium text-zinc-900 hover:underline dark:text-zinc-50" href="' + esc(link(x.runnerUp.p.slug)) + '">' + esc(x.runnerUp.p.name) + '</a>');
      html += insightCard(i + k, esc(x.cls.label) + ' MVP', 'Best all-round gains in class.', '<img class="size-7 shrink-0 object-contain" src="assets/img/classes/' + x.cls.key + '.png" alt="">', body);
    });
    return html + '</div>';
  }

  function moversSection(i) {
    var m = state.meta, both = state.players.filter(function (p) { return p.prev; });
    var top = function (get) { return both.filter(function (p) { return get(p) > 0; }).sort(function (a, b) { return get(b) - get(a); }).slice(0, 5); };
    var dealt = both.reduce(function (a, p) { return a + (p.dmgGain || 0); }, 0);
    var added = levelsAdded;
    var plural = function (n) { return '+' + n + (n === 1 ? ' level' : ' levels'); };
    return '<div class="grid gap-4 md:grid-cols-2 lg:grid-cols-3">' +
      moversCard(i, 'Biggest power gains', 'Most power added.', top(function (p) { return p.growth.power; }).map(function (p) {
        return { p: p, value: '+' + fmtNum(p.growth.power), sub: p.prev.power + ' to ' + p.power };
      })) +
      moversCard(i + 1, 'Biggest climbs', 'Most places gained on power.', top(function (p) { return p.growth.places; }).map(function (p) {
        return { p: p, value: '+' + p.growth.places + (p.growth.places === 1 ? ' place' : ' places'), sub: ordinal(p.pos.power_n + p.growth.places) + ' to ' + ordinal(p.pos.power_n) };
      })) +
      moversCard(i + 2, 'Most Conquest damage', 'Damage dealt in the period.', top(function (p) { return p.dmgGain; }).map(function (p) {
        return { p: p, value: '+' + fmtNum(p.dmgGain), sub: (dealt > 0 ? Math.round(100 * p.dmgGain / dealt) : 0) + '% of the guild\'s ' + fmtNum(dealt) };
      })) +
      moversCard(i + 3, 'Most equipment enhanced', 'Enhancement levels added.', top(function (p) { return added(p, ['gear']); }).map(function (p) {
        return { p: p, value: plural(added(p, ['gear'])), sub: 'average +' + Math.round(p.prev.stat_n.gear) + ' to +' + Math.round(p.stat_n.gear) };
      })) +
      moversCard(i + 4, 'Most technique and charm levels', 'Levels added across both.', top(function (p) { return added(p, ['technique', 'charm']); }).map(function (p) {
        return { p: p, value: plural(added(p, ['technique', 'charm'])), sub: 'tech +' + added(p, ['technique']) + ', charm +' + added(p, ['charm']) };
      })) +
      moversCard(i + 5, 'Most contributed', 'Added to total contribution.', top(function (p) { return p.totalGain; }).map(function (p) {
        return { p: p, value: '+' + fmtNum(p.totalGain), sub: p.prev.total + ' to ' + p.total };
      })) + '</div>';
  }

  function statCell(value, label, note) {
    return '<div class="rounded-xl border border-zinc-200/70 bg-white/40 p-3 dark:border-white/10 dark:bg-white/5"><p class="text-2xl font-semibold tracking-tight">' + esc(value) + '</p>' +
      '<p class="text-sm font-medium">' + esc(label) + '</p><p class="text-xs ' + MUTED + '">' + esc(note) + '</p></div>';
  }

  function growthCard(i) {
    var m = state.meta, both = state.players.filter(function (p) { return p.prev && p.growth.power != null; });
    var before = m.prevPlayers.reduce(function (a, p) { return a + (p.power_n || 0); }, 0);
    var gains = both.map(function (p) { return p.growth.power; });
    var avgGain = gains.length ? gains.reduce(function (a, b) { return a + b; }, 0) / gains.length : 0;
    var medNow = median(state.players.map(function (p) { return p.power_n; })), medWas = median(m.prevPlayers.map(function (p) { return p.power_n; }));
    var dealt = state.players.reduce(function (a, p) { return a + (p.dmgGain || 0); }, 0);
    var pct = before > 0 ? 100 * (m.totalPower - before) / before : 0;
    return insightCard(i, 'Guild growth', 'Since ' + esc(m.previousLabel) + ', ' + m.sinceDays + (m.sinceDays === 1 ? ' day' : ' days') + ' earlier.', icon('up', 'mt-1 size-4 ' + MUTED),
      '<div class="mt-4 grid grid-cols-2 gap-3 lg:grid-cols-4">' +
      statCell((pct >= 0 ? '+' : '-') + Math.abs(Math.round(pct * 10) / 10) + '%', 'Total power', fmtNum(before) + ' to ' + fmtNum(m.totalPower)) +
      statCell((avgGain >= 0 ? '+' : '-') + fmtNum(Math.abs(avgGain)), 'Average gain', 'per member, across the ' + both.length + ' in both') +
      statCell(fmtNum(medNow), 'Typical member\'s power', 'the middle of the guild; was ' + fmtNum(medWas)) +
      statCell(fmtNum(dealt), 'Conquest damage', 'dealt by the guild in the period') +
      '</div>');
  }

  // How many members each tier of the current and next dungeon is open to.
  function guildReadinessCard(t, i) {
    var m = state.meta, day = m.dir === state.latest ? tlToday(t) : Math.round((dirDate(m.dir) - tlStart(t)) / 86400000) + 1;
    var cur = null, next = null;
    tlDungeons(t).forEach(function (d) { if (d.day <= day) cur = d; else if (!next) next = d; });
    if (!cur) return '';
    var roster = state.players.filter(function (p) { return p.power_n != null; });
    function block(d, upcoming) {
      var html = '<div class="mt-4"><p class="flex flex-wrap items-baseline gap-x-2 text-sm font-semibold">' + esc(d.name) +
        '<span class="text-xs font-normal ' + MUTED + '">' + (upcoming ? 'opens ' + relDay(d.day - day).toLowerCase() + ', day ' + d.day : 'current dungeon') + '</span></p><div class="mt-2 space-y-2.5">';
      d.tiers.forEach(function (x) {
        var r = reqOf(x.req), ready = 0;
        roster.forEach(function (p) {
          var lv = p.profile && p.profile.level != null ? p.profile.level : null;
          if ((r.power == null || p.power_n >= r.power) && (r.level == null || lv == null || lv >= r.level)) ready++;
        });
        html += '<div title="' + ready + ' of ' + roster.length + ' members meet ' + esc(x.req || 'no requirement') + '"><div class="flex items-baseline justify-between gap-3 text-sm"><span class="font-medium">' + esc(x.diff) +
          ' <span class="text-xs font-normal ' + MUTED + '">' + (x.req ? esc(x.req) : 'no requirement') + '</span></span>' +
          '<span class="tabular-nums"><b class="font-semibold">' + ready + '</b> <span class="text-xs ' + MUTED + '">of ' + roster.length + '</span></span></div>' +
          '<div class="mt-1">' + meter(roster.length ? ready / roster.length : 0, 'bg-zinc-900 dark:bg-zinc-100') + '</div></div>';
      });
      return html + '</div></div>';
    }
    var body = block(cur, false) + (next ? block(next, true) : '');
    return insightCard(i, 'Dungeon readiness', 'Members whose power opens each tier.', icon('shield', 'mt-1 size-4 ' + MUTED), body);
  }

  function classCard(i) {
    var m = state.meta, groups = {};
    state.players.forEach(function (p) { var k = classKey(p); (groups[k] = groups[k] || []).push(p); });
    var avgOf = function (list, get) { var v = list.map(get).filter(function (x) { return x != null; }); return v.length ? v.reduce(function (a, b) { return a + b; }, 0) / v.length : null; };
    var body = '<div class="mt-3 overflow-x-auto"><table class="w-full text-sm"><thead class="text-xs ' + MUTED + '"><tr>' +
      '<th scope="col" class="py-2 text-left font-medium">Class</th><th scope="col" class="px-2 py-2 text-right font-medium">Members</th>' +
      '<th scope="col" class="px-2 py-2 text-right font-medium">Avg power</th><th scope="col" class="hidden px-2 py-2 text-right font-medium sm:table-cell">Avg equip</th>' +
      '<th scope="col" class="w-2/5 py-2 pl-2 text-left font-medium">Share of Conquest damage</th></tr></thead><tbody class="divide-y divide-zinc-200/60 dark:divide-white/5">';
    m.classes.forEach(function (c) {
      var list = groups[c.key] || [], dmg = list.reduce(function (a, p) { return a + (p.dmg_n || 0); }, 0);
      var share = m.totalDmg > 0 ? dmg / m.totalDmg : 0, gear = avgOf(list, function (p) { return p.stat_n.gear; });
      body += '<tr><th scope="row" class="py-2.5 text-left font-medium"><span class="inline-flex items-center gap-2">' +
        (c.key === 'unknown' ? icon('cls-unknown', 'size-4') : '<img class="size-5 object-contain" src="assets/img/classes/' + c.key + '.png" alt="">') + esc(c.label) + '</span></th>' +
        '<td class="px-2 py-2.5 text-right tabular-nums">' + c.count + '</td>' +
        '<td class="px-2 py-2.5 text-right tabular-nums">' + esc(fmtNum(avgOf(list, function (p) { return p.power_n; }))) + '</td>' +
        '<td class="hidden px-2 py-2.5 text-right tabular-nums sm:table-cell">' + (gear != null ? '+' + Math.round(gear) : '-') + '</td>' +
        '<td class="py-2.5 pl-2" title="' + esc(c.label) + ': ' + esc(fmtNum(dmg)) + ' of ' + esc(fmtNum(m.totalDmg)) + '"><div class="flex items-center gap-2"><div class="min-w-0 flex-1">' + meter(share, 'bg-' + c.key) + '</div>' +
        '<span class="w-9 shrink-0 text-right text-xs font-semibold tabular-nums">' + Math.round(share * 100) + '%</span></div></td></tr>';
    });
    return insightCard(i, 'Class breakdown', 'Who the guild is made of, and who deals the damage.', icon('people', 'mt-1 size-4 ' + MUTED), body + '</tbody></table></div>');
  }

  // One hue, strongest for the top player, so the split reads as a ranking.
  var SHARE_STEPS = ['bg-violet-800 dark:bg-violet-300', 'bg-violet-600 dark:bg-violet-400', 'bg-violet-400 dark:bg-violet-600', 'bg-violet-200 dark:bg-violet-800'];

  function concentrationCard(i) {
    var m = state.meta, list = state.players.filter(function (p) { return p.dmg_n > 0; }).sort(function (a, b) { return b.dmg_n - a.dmg_n; });
    if (!list.length || !(m.totalDmg > 0)) return '';
    var sumOf = function (a, b) { return list.slice(a, b).reduce(function (s, p) { return s + p.dmg_n; }, 0); };
    var parts = [[list[0].name, sumOf(0, 1)], ['2nd to 5th', sumOf(1, 5)], ['6th to 10th', sumOf(5, 10)], ['Everyone else, ' + Math.max(0, list.length - 10) + ' members', sumOf(10)]]
      .filter(function (x) { return x[1] > 0; });
    var body = '<p class="mt-4 flex items-baseline gap-2"><span class="text-3xl font-semibold tracking-tight">' + Math.round(100 * sumOf(0, 5) / m.totalDmg) + '%</span>' +
      '<span class="text-sm ' + MUTED + '">of all Conquest damage comes from the top 5</span></p>' +
      '<div class="mt-4 flex h-3 gap-0.5 overflow-hidden rounded-full" role="img" aria-label="Share of Conquest damage by rank group">';
    parts.forEach(function (x, k) {
      body += '<i class="block h-full ' + SHARE_STEPS[k] + '" style="width:' + (100 * x[1] / m.totalDmg) + '%" title="' + esc(x[0]) + ': ' + esc(fmtNum(x[1])) + ', ' + Math.round(100 * x[1] / m.totalDmg) + '%"></i>';
    });
    body += '</div><ul class="mt-4 space-y-2 text-sm">';
    parts.forEach(function (x, k) {
      body += '<li class="flex items-center gap-2"><i class="size-2.5 shrink-0 rounded-sm ' + SHARE_STEPS[k] + '"></i><span class="min-w-0 flex-1 truncate">' + (k === 0 ? '<a class="font-medium hover:underline" href="' + esc(link(list[0].slug)) + '">' + esc(x[0]) + '</a>' : esc(x[0])) + '</span>' +
        '<span class="tabular-nums ' + MUTED + '">' + esc(fmtNum(x[1])) + '</span><b class="w-10 text-right font-semibold tabular-nums">' + Math.round(100 * x[1] / m.totalDmg) + '%</b></li>';
    });
    return insightCard(i, 'Who carries Conquest', 'How the guild\'s ' + esc(fmtNum(m.totalDmg)) + ' Conquest damage splits.', icon('swords', 'mt-1 size-4 ' + MUTED), body + '</ul>');
  }

  // Counts only: this is a public page, so nobody is named for a low week.
  function contributionHealthCard(i) {
    var m = state.meta, roster = state.players.filter(function (p) { return p.rosterOrder != null && p.week_n != null; }), top = m.weekTop;
    if (!roster.length || !(top > 0)) return '';
    var bands = [['Maxed', '95%+', 0.95, 2], ['Nearly there', '75 to 95%', 0.75, 0.95], ['Halfway', '50 to 75%', 0.5, 0.75], ['Low', 'under 50%', 1e-9, 0.5], ['Nothing yet', '', -1, 1e-9]].map(function (b) {
      return { label: b[0], range: b[1], count: roster.filter(function (p) { var r = p.week_n / top; return r >= b[2] && r < b[3]; }).length };
    });
    var most = Math.max.apply(null, bands.map(function (b) { return b.count; }));
    var body = '<p class="mt-4 flex items-baseline gap-2"><span class="text-3xl font-semibold tracking-tight">' + bands[0].count + '</span>' +
      '<span class="text-sm ' + MUTED + '">of ' + roster.length + ' members are at or near this week\'s top, ' + esc(fmtNum(top)) + '</span></p><div class="mt-4 space-y-2.5">';
    bands.forEach(function (b) {
      body += '<div class="flex items-center gap-3 text-sm" title="' + b.count + ' members: ' + esc(b.label) + (b.range ? ', ' + esc(b.range) + ' of the top' : '') + '"><span class="w-40 shrink-0"><span class="font-medium">' + esc(b.label) + '</span> <span class="text-xs ' + MUTED + '">' + esc(b.range) + '</span></span>' +
        '<div class="min-w-0 flex-1">' + meter(most ? b.count / most : 0, 'bg-zinc-900 dark:bg-zinc-100') + '</div><b class="w-6 shrink-0 text-right font-semibold tabular-nums">' + b.count + '</b></div>';
    });
    body += '</div>';
    var lines = ['The typical member gave ' + fmtNum(m.weekMedian) + ' this week, ' + Math.round(100 * m.weekMedian / top) + '% of the top.'];
    if (m.totalGainMedian != null) lines.push('The typical member added ' + fmtNum(m.totalGainMedian) + ' to their total since ' + m.previousLabel + '.');
    return insightCard(i, 'Weekly contribution check', 'How close everyone is to the highest weekly contribution in the guild.', icon('gem', 'mt-1 size-4 ' + MUTED), body + cardFoot(lines.map(esc).join('<br>')));
  }

  function fantomonCard(i) {
    var counts = {}, total = 0;
    state.players.forEach(function (p) { var sp = p.profile && fantomonSpecies(p.profile); if (sp) { counts[sp] = (counts[sp] || 0) + 1; total++; } });
    var list = Object.keys(counts).map(function (k) { return [k, counts[k]]; }).sort(function (a, b) { return b[1] - a[1] || a[0].localeCompare(b[0]); });
    if (!list.length) return '';
    var body = '<ul class="mt-3 space-y-2">';
    list.forEach(function (x) {
      body += '<li class="flex items-center gap-3 text-sm" title="' + x[1] + ' of ' + total + ' members use ' + esc(x[0]) + '"><img class="size-8 shrink-0 object-contain" src="assets/img/fantomons/' + slugify(x[0]) + '.png" alt="" loading="lazy" decoding="async">' +
        '<span class="w-24 shrink-0 truncate font-medium">' + esc(x[0]) + '</span><div class="min-w-0 flex-1">' + meter(x[1] / list[0][1], 'bg-zinc-900 dark:bg-zinc-100') + '</div>' +
        '<b class="w-6 shrink-0 text-right font-semibold tabular-nums">' + x[1] + '</b></li>';
    });
    return insightCard(i, 'Fantomon popularity', 'Which companions the guild runs.', icon('fantomon', 'mt-1 size-4 ' + MUTED), body + '</ul>');
  }

  function recordsCard(i) {
    var m = state.meta, cols = [['atk', 'Attack'], ['def', 'Defense'], ['hp', 'HP'], ['spd', 'Speed']];
    var withStats = state.players.filter(function (p) { return p.profile && p.profile.stats; });
    if (!withStats.length) return '';
    function row(label, list, emblem) {
      var html = '<tr><th scope="row" class="py-2.5 pr-3 text-left font-medium"><span class="inline-flex items-center gap-2 whitespace-nowrap">' + emblem + esc(label) + '</span></th>';
      cols.forEach(function (c) {
        var best = null;
        list.forEach(function (p) { if (p.stat_n[c[0]] != null && (!best || p.stat_n[c[0]] > best.stat_n[c[0]])) best = p; });
        html += '<td class="px-2 py-2.5">' + (best ? '<a class="block truncate font-medium hover:underline" href="' + esc(link(best.slug)) + '">' + esc(best.name) + '</a><span class="text-xs tabular-nums ' + MUTED + '">' + esc(best.profile.stats[c[0]]) + '</span>' : '<span class="' + MUTED + '">-</span>') + '</td>';
      });
      return html + '</tr>';
    }
    var body = '<div class="mt-3 overflow-x-auto"><table class="w-full min-w-[34rem] table-fixed text-sm"><thead class="text-xs ' + MUTED + '"><tr><th scope="col" class="w-36 py-2 text-left font-medium">Best in</th>';
    cols.forEach(function (c) { body += '<th scope="col" class="px-2 py-2 text-left font-medium">' + c[1] + '</th>'; });
    body += '</tr></thead><tbody class="divide-y divide-zinc-200/60 dark:divide-white/5">' + row('Whole guild', withStats, icon('trophy', 'size-4 text-amber-500'));
    m.classes.forEach(function (c) {
      if (c.key === 'unknown') return;
      body += row(c.label, withStats.filter(function (p) { return classKey(p) === c.key; }), '<img class="size-5 object-contain" src="assets/img/classes/' + c.key + '.png" alt="">');
    });
    return insightCard(i, 'Record holders', 'The highest combat stats in the guild and in each class.', icon('medal', 'mt-1 size-4 ' + MUTED), body + '</tbody></table></div>');
  }

  // ---- rendering: profile insights -------------------------------------------
  // Cards between the standing tiles and the stat panels: what to work on, which
  // dungeon tiers the player's power opens, who is next to them on power, and how
  // their damage and contribution compare.

  var CHIP = {
    good: 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300',
    warn: 'border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-300',
    bad: 'border-red-200 bg-red-50 text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300',
    flat: 'border-zinc-200/70 bg-white/70 text-zinc-700 dark:border-white/10 dark:bg-zinc-800/70 dark:text-zinc-300'
  };

  function chip(tone, text) {
    return '<span class="inline-flex shrink-0 items-center rounded-md border px-1.5 py-0.5 text-[11px] font-medium ' + CHIP[tone] + '">' + text + '</span>';
  }

  // Closing line of a card, pinned to the bottom when cards in a row differ in height.
  function cardFoot(html) {
    return '<div class="mt-auto pt-4"><p class="border-t border-zinc-200/70 pt-3 text-sm ' + MUTED + ' dark:border-white/10">' + html + '</p></div>';
  }

  function insightCard(i, title, sub, aside, body, extra) {
    return '<section class="' + CARD + ' flex h-full flex-col p-5 ' + (extra || '') + ' ' + ANIM + '" style="--i:' + Math.min(i, 14) + '">' +
      '<div class="flex items-start justify-between gap-3"><div class="min-w-0"><h2 class="text-base font-semibold">' + title + '</h2>' +
      (sub ? '<p class="text-sm ' + MUTED + '">' + sub + '</p>' : '') + '</div>' + (aside || '') + '</div>' + body + '</section>';
  }

  // The earlier profile capture to measure progress against, or null when this
  // snapshot has no capture of its own (a borrowed one would show no change).
  function prevProfile(p) {
    var pr = p.profile, q = p.prev && p.prev.profile;
    return pr && q && pr.snapshot === state.meta.dir && q.snapshot !== pr.snapshot ? q : null;
  }

  function intOf(v) { var n = parseInt(String(v).replace('+', ''), 10); return isNaN(n) ? null : n; }

  // Like fmtDelta, but silent when nothing moved.
  function gain(now, before) {
    var d = fmtDelta(now, before);
    return d === '±0' ? '' : d;
  }

  // Averages to compare against: the player's class when it has a few members,
  // the whole guild otherwise.
  function peerGroup(p) {
    var m = state.meta, ck = classKey(p);
    if (ck !== 'unknown' && p.classSize >= 3) return { avg: m.classAvg[ck], name: p.profile['class'], label: 'the ' + p.classSize + ' ' + p.profile['class'] + 's in the guild' };
    return { avg: m.guildAvg, name: 'guild', label: 'the whole guild' };
  }

  var GEAR_SLOTS = ['weapon', 'tome', 'belt', 'armor', 'boots'];

  function focusCard(p, i) {
    var pr = p.profile;
    if (!pr) return '';
    var g = peerGroup(p), items = [];
    var groups = [['gear', 'Equip', '+', pr.gear, 'equipment'], ['tech', 'Technique', 'Lv. ', pr.technique, 'technique'], ['charm', 'Charm', 'Lv. ', pr.charm, 'charm']];

    var behind = groups.map(function (x) {
      var v = p.stat_n[x[0]], avg = g.avg[x[0]];
      return v == null || avg == null ? null : { g: x, diff: Math.round(v) - Math.round(avg), v: v, avg: avg };
    }).filter(function (x) { return x && x.diff <= -1; }).sort(function (a, b) { return a.diff - b.diff; });
    behind.forEach(function (x, k) {
      items.push({ tone: 'warn', ic: 'up', title: (k === 0 ? 'Biggest gap: ' : 'Also behind: ') + x.g[4],
        text: 'Your average is ' + x.g[2] + Math.round(x.v) + ', ' + Math.abs(x.diff) + (Math.abs(x.diff) === 1 ? ' level' : ' levels') + ' under the ' + g.name + ' average of ' + x.g[2] + Math.round(x.avg) + '.' });
    });

    groups.forEach(function (x) {
      var vals = (x[3] || []).map(intOf), known = vals.filter(function (v) { return v != null; });
      if (known.length < 2) return;
      var lo = Math.min.apply(null, known), hi = Math.max.apply(null, known);
      if (hi - lo < (x[0] === 'gear' ? 10 : 3)) return;
      var at = vals.indexOf(lo);
      items.push({ tone: 'warn', ic: 'updown', title: 'Uneven ' + x[4],
        text: (x[0] === 'gear' ? 'Your ' + GEAR_SLOTS[at] : 'Slot ' + (at + 1)) + ' is at ' + x[2] + lo + ' while your best is ' + x[2] + hi + '.' });
    });

    var stats = [['atk', 'attack'], ['def', 'defense'], ['hp', 'HP'], ['spd', 'speed']].map(function (s) {
      var v = p.stat_n[s[0]], avg = g.avg[s[0]];
      return v == null || !avg ? null : { label: s[1], v: v, avg: avg, rel: (v - avg) / avg };
    }).filter(Boolean).sort(function (a, b) { return a.rel - b.rel; });
    var weak = stats[0], strong = stats[stats.length - 1];
    if (weak && weak.rel <= -0.1) items.push({ tone: 'warn', ic: 'down', title: 'Weakest stat: ' + weak.label,
      text: fmtNum(weak.v) + ' is ' + Math.round(-weak.rel * 100) + '% under the ' + g.name + ' average of ' + fmtNum(weak.avg) + '.' });
    if (!behind.length) items.unshift({ tone: 'good', ic: 'trophy', title: 'Upgrades on track',
      text: 'Equipment, technique and charm are all level with or ahead of the ' + g.name + ' average.' });
    if (strong && strong !== weak && strong.rel >= 0.1) items.push({ tone: 'good', ic: 'star', title: 'Strongest stat: ' + strong.label,
      text: fmtNum(strong.v) + ' is ' + Math.round(strong.rel * 100) + '% over the ' + g.name + ' average of ' + fmtNum(strong.avg) + '.' });

    var body = '<ul class="mt-4 space-y-3">';
    items.slice(0, 4).forEach(function (it) {
      body += '<li class="flex items-start gap-3"><span class="mt-0.5 grid size-8 shrink-0 place-items-center rounded-md border ' + CHIP[it.tone] + '">' + icon(it.ic, 'size-4') + '</span>' +
        '<div class="min-w-0 text-sm"><p class="font-medium">' + esc(it.title) + '</p><p class="' + MUTED + '">' + esc(it.text) + '</p></div></li>';
    });
    body += '</ul><div class="mt-auto pt-4"><table class="w-full border-t border-zinc-200/70 text-sm dark:border-white/10">' +
      '<thead class="text-xs ' + MUTED + '"><tr><th scope="col" class="pb-1 pt-3 text-left font-medium">Average level</th><th scope="col" class="pb-1 pt-3 text-right font-medium">You</th>' +
      '<th scope="col" class="pb-1 pt-3 text-right font-medium">' + esc(g.name.charAt(0).toUpperCase() + g.name.slice(1)) + '</th><th scope="col" class="w-20 pb-1 pt-3 text-right font-medium">Gap</th></tr></thead><tbody>';
    groups.forEach(function (x) {
      var v = p.stat_n[x[0]], avg = g.avg[x[0]];
      var diff = v != null && avg != null ? Math.round(v) - Math.round(avg) : null;
      body += '<tr><th scope="row" class="py-1 text-left font-medium">' + x[1] + '</th>' +
        '<td class="py-1 text-right font-semibold tabular-nums">' + (v != null ? x[2] + Math.round(v) : '-') + '</td>' +
        '<td class="py-1 text-right tabular-nums ' + MUTED + '">' + (avg != null ? x[2] + Math.round(avg) : '-') + '</td>' +
        '<td class="py-1 text-right">' + (diff == null ? '' : deltaHTML(diff === 0 ? '±0' : (diff > 0 ? '+' : '-') + Math.abs(diff))) + '</td></tr>';
    });
    return insightCard(i, 'What to upgrade next', 'Compared with ' + esc(g.label) + '.', icon('eye', 'mt-1 size-4 ' + MUTED), body + '</tbody></table></div>');
  }

  // "930K + Lv. 100" on the timeline means power and a character level.
  function reqOf(text) {
    var lv = /Lv\.\s*(\d+)/.exec(text || '');
    return { power: parseNum(String(text || '').split('+')[0]), level: lv ? parseInt(lv[1], 10) : null };
  }

  function readinessCard(p, t, i) {
    var m = state.meta;
    if (p.power_n == null) return '';
    // The latest snapshot is judged against today's schedule, an older one
    // against the schedule on the day it was captured.
    var day = m.dir === state.latest ? tlToday(t) : Math.round((dirDate(m.dir) - tlStart(t)) / 86400000) + 1;
    var cur = null, next = null;
    tlDungeons(t).forEach(function (d) { if (d.day <= day) cur = d; else if (!next) next = d; });
    if (!cur) return '';
    var level = p.profile && p.profile.level != null ? p.profile.level : null;
    var target = null, best = null;

    function block(d, upcoming) {
      var html = '<div class="mt-4"><p class="flex flex-wrap items-baseline gap-x-2 text-sm font-semibold">' + esc(d.name) +
        '<span class="text-xs font-normal ' + MUTED + '">' + (upcoming ? 'opens ' + relDay(d.day - day).toLowerCase() + ', day ' + d.day : 'current dungeon') + '</span></p>' +
        '<ul class="mt-1.5 divide-y divide-zinc-200/60 text-sm dark:divide-white/5">';
      d.tiers.forEach(function (x) {
        var r = reqOf(x.req), unknown = !!x.req && r.power == null && r.level == null;
        var shortBy = r.power != null ? r.power - p.power_n : 0;
        var lvShort = r.level != null && level != null ? r.level - level : 0;
        var ok = !unknown && shortBy <= 0 && lvShort <= 0;
        if (ok && !upcoming) best = x.diff;
        if (!ok && shortBy > 0 && (!target || shortBy < target.shortBy)) target = { shortBy: shortBy, name: d.name + ' ' + x.diff };
        var status = unknown ? chip('flat', 'Not announced') : ok ? chip('good', 'Ready') :
          chip('warn', shortBy > 0 ? fmtNum(shortBy) + ' short' : 'Needs Lv. ' + r.level);
        html += '<li class="flex items-center justify-between gap-3 py-2"><span class="flex min-w-0 items-center gap-2">' +
          icon(ok ? 'check' : 'lock', 'size-4 ' + (ok ? 'text-emerald-600 dark:text-emerald-400' : MUTED)) +
          '<span class="font-medium">' + esc(x.diff) + '</span>' +
          (x.day > d.day && x.day > day ? '<span class="text-xs ' + MUTED + '">' + relDay(x.day - day).toLowerCase() + '</span>' : '') + '</span>' +
          '<span class="flex shrink-0 items-center gap-2"><span class="text-xs tabular-nums ' + MUTED + '">' + (x.req ? esc(x.req) : 'No requirement') + '</span>' + status + '</span></li>';
      });
      return html + '</ul></div>';
    }

    var body = block(cur, false) + (next ? block(next, true) : '');
    if (target) {
      var pace = p.growth && p.growth.power > 0 && m.sinceDays > 0 ? p.growth.power / m.sinceDays : 0;
      var days = pace ? Math.ceil(target.shortBy / pace) : null;
      body += cardFoot('<span class="text-zinc-900 dark:text-zinc-50"><span class="' + MUTED + '">Next unlock:</span> <b class="font-semibold">' + esc(target.name) + '</b>, ' + fmtNum(target.shortBy) + ' to go.' +
        (days && days <= 120 ? ' <span class="' + MUTED + '">Roughly ' + (days < 14 ? days + (days === 1 ? ' day' : ' days') : Math.round(days / 7) + ' weeks') + ' at your recent pace of ' + esc(p.delta.power) + ' in ' + m.sinceDays + ' days. An estimate from two snapshots.</span>' : '') + '</span>');
    }
    return insightCard(i, 'Dungeon readiness', 'What ' + esc(p.power) + ' power' + (level != null ? ' at level ' + esc(level) : '') + ' opens.',
      best ? chip('good', 'Up to ' + esc(best)) : chip('warn', 'Below ' + esc(cur.tiers[0].diff)), body);
  }

  function rivalsCard(p, i) {
    var m = state.meta;
    if (p.power_n == null) return '';
    var order = state.players.filter(function (x) { return x.power_n != null; }).sort(function (a, b) { return a.pos.power_n - b.pos.power_n; });
    var at = order.indexOf(p), from = Math.max(0, Math.min(at - 2, order.length - 5));
    var body = '<ul class="mt-3 divide-y divide-zinc-200/60 dark:divide-white/5">';
    order.slice(from, from + 5).forEach(function (x) {
      var self = x === p, gap = Math.abs(x.power_n - p.power_n);
      var note = self ? 'You' : gap < 0.5 ? 'Level with you' : x.pos.power_n < p.pos.power_n ? fmtNum(gap) + ' to pass' : fmtNum(gap) + ' behind you';
      body += '<li class="flex items-center gap-3 py-2 text-sm' + (self ? ' -mx-2 rounded-lg bg-zinc-900/[0.04] px-2 dark:bg-white/[0.06]' : '') + '">' +
        '<span class="w-6 shrink-0 text-center text-xs tabular-nums ' + MUTED + '">' + x.pos.power_n + '</span>' + avatar(x) +
        '<div class="min-w-0 flex-1">' + (self ? '<p class="truncate font-semibold">' + esc(x.name) + '</p>' : '<a class="block truncate font-medium hover:underline" href="' + esc(link(x.slug)) + '">' + esc(x.name) + '</a>') +
        '<p class="text-xs ' + MUTED + '">' + esc(note) + '</p></div>' +
        '<div class="shrink-0 text-right"><p class="font-semibold tabular-nums">' + esc(x.power) + '</p>' + (x.delta.power ? '<p>' + deltaHTML(x.delta.power) + '</p>' : '') + '</div></li>';
    });
    body += '</ul>';
    var above = at > 0 ? order[at - 1] : null, below = order[at + 1], line = '';
    if (!above && below) line = 'Top of the guild on power, ' + fmtNum(p.power_n - below.power_n) + ' clear of ' + below.name + '.';
    else if (above && p.growth.power != null && above.growth.power != null) {
      var edge = p.growth.power - above.growth.power;
      if (edge >= 0.5) line = 'Closing in: you gained ' + fmtNum(edge) + ' more than ' + above.name + ' since ' + m.previousLabel + '.';
      else if (edge <= -0.5) line = above.name + ' is pulling away, gaining ' + fmtNum(-edge) + ' more than you since ' + m.previousLabel + '.';
      else line = 'You and ' + above.name + ' gained the same since ' + m.previousLabel + '.';
    }
    if (line) body += cardFoot(esc(line));
    return insightCard(i, 'Nearest rivals', 'Either side of you on power.', icon('swords', 'mt-1 size-4 ' + MUTED), body);
  }

  function median(vals) {
    var s = vals.filter(function (v) { return v != null; }).sort(function (a, b) { return a - b; });
    if (!s.length) return null;
    return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
  }

  function pairBars(a, b, tone) {
    var max = Math.max(a[1], b[1], 1);
    function row(x, color) {
      return '<div><div class="flex items-baseline justify-between gap-3 text-xs"><span class="' + MUTED + '">' + x[0] + '</span><b class="font-semibold tabular-nums">' + esc(fmtNum(x[1])) + '</b></div>' +
        '<div class="mt-1">' + meter(x[1] / max, color) + '</div></div>';
    }
    return '<div class="mt-4 space-y-3">' + row(a, tone) + row(b, 'bg-zinc-400 dark:bg-zinc-500') + '</div>';
  }

  // Conquest damage is a running total, so where an earlier snapshot exists the
  // comparison uses what was dealt since then; that is fair to newer members.
  function damageCard(p, i) {
    var m = state.meta, title = 'Punching above your weight?';
    if (p.dmg_n == null) return insightCard(i, title, '', icon('sword', 'mt-1 size-4 ' + MUTED), '<p class="mt-4 text-sm ' + MUTED + '">No Conquest damage is recorded for this player in this snapshot.</p>');
    // Someone who joined since the last snapshot has a few days of damage against
    // everyone else's running total, so they get no verdict yet.
    if (m.previousLabel && !p.prev) return insightCard(i, title, 'Conquest damage, against similar power.', chip('flat', 'New member'),
      '<p class="mt-4 flex items-baseline gap-2"><span class="text-3xl font-semibold tracking-tight">' + esc(p.dmg) + '</span><span class="text-sm ' + MUTED + '">so far</span></p>' +
      cardFoot('Joined since ' + esc(m.previousLabel) + '. Conquest damage is a running total, so a fair comparison starts with the next snapshot, using what each member dealt in between.'));
    var useGain = p.dmgGain != null;
    var get = function (x) { return useGain ? x.dmgGain : x.dmg_n; };
    var peers = p.power_n == null ? [] : state.players.filter(function (x) { return x !== p && x.power_n != null && get(x) != null; })
      .sort(function (a, b) { return Math.abs(a.power_n - p.power_n) - Math.abs(b.power_n - p.power_n); }).slice(0, 10);
    var mid = median(peers.map(get)), body = '', aside = icon('sword', 'mt-1 size-4 ' + MUTED);
    var what = useGain ? 'Conquest damage since ' + esc(m.previousLabel) : 'Conquest damage';
    if (peers.length >= 4 && mid > 0) {
      var ratio = get(p) / mid, powers = peers.map(function (x) { return x.power_n; });
      var tone = ratio >= 1.25 ? 'good' : ratio <= 0.8 ? 'warn' : 'flat';
      aside = chip(tone, ratio >= 1.25 ? 'Above your weight' : ratio <= 0.8 ? 'Below your weight' : 'In line');
      body += '<p class="mt-4 flex items-baseline gap-2"><span class="text-3xl font-semibold tracking-tight">' + (ratio < 2 ? Math.round(ratio * 100) + '%' : (ratio >= 10 ? Math.round(ratio) : ratio.toFixed(1)) + 'x') + '</span>' +
        '<span class="text-sm ' + MUTED + '">' + (ratio < 2 ? 'of ' : '') + 'what members near your power dealt</span></p>' +
        pairBars(['You', get(p)], ['The ' + peers.length + ' closest in power, ' + esc(fmtNum(Math.min.apply(null, powers))) + ' to ' + esc(fmtNum(Math.max.apply(null, powers))), mid],
          tone === 'warn' ? 'bg-amber-500' : tone === 'good' ? 'bg-emerald-500' : 'bg-zinc-900 dark:bg-zinc-100');
    } else {
      body += '<p class="mt-4 text-sm ' + MUTED + '">Not enough members with damage near this power to compare against.</p>';
    }
    var lines = [];
    if (p.pos.power_n && p.pos.dmg_n) lines.push('In the guild: ' + ordinal(p.pos.power_n) + ' on power, ' + ordinal(p.pos.dmg_n) + ' on Conquest damage.');
    if (classKey(p) !== 'unknown' && p.classSize >= 3 && p.cpos.power_n && p.cpos.dmg_n) lines.push('Among ' + p.classSize + ' ' + p.profile['class'] + 's: ' + ordinal(p.cpos.power_n) + ' on power, ' + ordinal(p.cpos.dmg_n) + ' on Conquest damage.');
    if (lines.length) body += cardFoot(lines.map(esc).join('<br>'));
    return insightCard(i, title, what + ', against similar power.', aside, body);
  }

  function contributionCard(p, i) {
    var m = state.meta;
    if (p.week_n == null) return '';
    var top = m.weekTop, mid = m.weekMedian;
    var tone = !(p.week_n > 0) ? 'bad' : mid != null && p.week_n < mid ? 'warn' : 'good';
    var tick = top > 0 && mid != null ? Math.min(100, Math.round(100 * mid / top)) : null;
    var body = '<p class="mt-4 flex items-baseline gap-2"><span class="text-3xl font-semibold tracking-tight">' + (top > 0 ? Math.round(100 * p.week_n / top) : 0) + '%</span>' +
      '<span class="text-sm ' + MUTED + '">of this week\'s top, ' + esc(fmtNum(top)) + '</span></p>' +
      '<div class="relative mt-4">' + meter(top > 0 ? p.week_n / top : 0, tone === 'good' ? 'bg-emerald-500' : tone === 'warn' ? 'bg-amber-500' : 'bg-red-500') +
      (tick != null ? '<span class="absolute -top-1 h-3.5 w-0.5 rounded-full bg-zinc-400 dark:bg-zinc-500" style="left:' + tick + '%" title="Typical member"></span>' : '') + '</div>' +
      '<div class="mt-1.5 flex justify-between gap-3 text-xs ' + MUTED + '"><span>You <b class="font-medium text-zinc-700 dark:text-zinc-200">' + esc(p.week) + '</b></span>' +
      (mid != null ? '<span>Typical member <b class="font-medium text-zinc-700 dark:text-zinc-200">' + esc(fmtNum(mid)) + '</b></span>' : '') + '</div>';
    var lines = [];
    if (m.totalWeek > 0) lines.push((Math.round(1000 * p.week_n / m.totalWeek) / 10) + '% of the guild\'s ' + fmtNum(m.totalWeek) + ' this week. An even split would be ' + (Math.round(1000 / m.memberCount) / 10) + '%.');
    if (m.previousLabel && !p.prev) lines.push('Joined since ' + m.previousLabel + ', so this may be a part week.');
    if (p.totalGain != null && m.totalGainMedian != null) lines.push('Added ' + fmtNum(p.totalGain) + ' to your total since ' + m.previousLabel + '. The typical member added ' + fmtNum(m.totalGainMedian) + '.');
    if (lines.length) body += cardFoot(lines.map(esc).join('<br>'));
    return insightCard(i, 'Your contribution this week', 'Weekly contribution against the rest of the guild.',
      chip(tone, tone === 'bad' ? 'Nothing yet' : tone === 'warn' ? 'Below typical' : 'On par or better'), body);
  }

  // ---- rendering: profile ---------------------------------------------------

  function dl(label, value, extra) {
    return '<div><dt class="text-xs font-medium ' + MUTED + '">' + label + '</dt><dd class="mt-0.5 truncate font-medium ' + (extra || '') + '">' + value + '</dd></div>';
  }

  function meter(w, color) {
    return '<div class="meter h-1.5 w-full overflow-hidden rounded-full bg-zinc-100 dark:bg-zinc-800"><i class="' + color + '" data-w="' + Math.round(w * 100) + '"></i></div>';
  }

  function renderProfile(p) {
    var m = state.meta, pr = p.profile || {}, st = pr.stats || {}, n = m.memberCount;
    var was = prevProfile(p);
    var up = function (now, before) { var d = was ? gain(now, before) : ''; return d ? ' ' + deltaHTML(d) : ''; };
    var order = sortedPlayers();
    var at = order.map(function (x) { return x.slug; }).indexOf(p.slug);
    var prev = at > 0 ? order[at - 1] : null;
    var next = at >= 0 && at < order.length - 1 ? order[at + 1] : null;
    var i = 0;

    var html = pastNotice(p.slug) + topBar(p.slug, prev, next, i++);

    var sub = [];
    if (pr['class']) sub.push(pr['class'] + (pr.classLevel != null ? ', class level ' + pr.classLevel : ''));
    else sub.push('Class not captured');
    html += '<section class="' + CARD + ' p-5 sm:p-6 ' + ANIM + '" style="--i:' + i++ + '" aria-label="Player card">' +
      '<div class="flex flex-col gap-6 sm:flex-row sm:items-start sm:justify-between">' +
      '<div class="flex items-start gap-4">' + avatar(p, 'lg') +
      '<div class="min-w-0"><h1 class="text-2xl font-semibold tracking-tight">' + esc(p.name) + '</h1>' +
      '<p class="mt-0.5 flex flex-wrap items-center text-sm ' + MUTED + '">' + classInline(p) + (pr.classLevel != null ? '<span>, class level ' + esc(pr.classLevel) + up(pr.classLevel, was && was.classLevel) + '</span>' : '') + '</p>' +
      '<div class="mt-3 flex flex-wrap gap-1.5">' +
      (pr.level != null ? '<span class="' + BADGE + '">Level ' + esc(pr.level) + up(pr.level, was && was.level) + '</span>' : '') +
      roleBadge(p) +
      ((pr.badges && pr.badges.rank) || p.rank ? '<span class="' + BADGE + '">' + icon('medal', 'size-3 text-amber-500') + esc((pr.badges && pr.badges.rank) || p.rank) + '</span>' : '') +
      fantomonBadge(pr) +
      classBadges(p).join('') + growthBadges(p).join('') +
      '</div></div></div>' +
      '<div class="flex shrink-0 items-center gap-5 sm:flex-row-reverse">' +
      shotThumb(p) +
      (fantomonImg(pr, 'size-16') ? '<div class="flex flex-col items-center gap-1"><span class="grid size-20 place-items-center rounded-xl bg-white/60 ring-1 ring-inset ring-white/70 dark:bg-white/5 dark:ring-white/10">' + fantomonImg(pr, 'size-16') + '</span><span class="text-xs ' + MUTED + '">' + esc(fantomonSpecies(pr)) + (fantomonRenamed(pr) ? ' <span class="opacity-70">"' + esc(fantomonRenamed(pr)) + '"</span>' : '') + '</span></div>' : '') +
      '<div class="sm:text-right"><p class="text-sm font-medium ' + MUTED + '">Power</p>' +
      '<p class="text-4xl font-semibold tracking-tight" id="hero-power">' + esc(p.power || '-') + '</p>' +
      (p.delta.power ? '<p class="mt-1 text-sm ' + MUTED + '">' + deltaHTML(p.delta.power) + ' since ' + esc(m.previousLabel) + '</p>' : '') +
      '</div></div></div>' +
      '<dl class="mt-6 grid grid-cols-2 gap-x-6 gap-y-4 border-t border-zinc-200/70 pt-6 text-sm sm:grid-cols-4 dark:border-white/10">' +
      dl('Player ID', esc(pr.playerId || '-')) +
      dl('Guild', esc((pr.badges && pr.badges.guildTitle) || m.guild)) +
      dl('Server', esc((pr.badges && pr.badges.serverTitle) || m.server || '-')) +
      dl('Likes', esc(pr.likes || '-') + up(parseNum(pr.likes), was && parseNum(was.likes))) +
      '</dl></section>';

    var standing = [
      ['swords', 'Power', p.pos.power_n, p.power, p.delta.power],
      ['gem', 'Weekly contribution', p.pos.week_n, p.week, ''],
      ['trophy', 'Total contribution', p.pos.total_n, p.total, p.delta.total],
      ['sword', 'Conquest damage', p.pos.dmg_n, p.dmg, p.delta.dmg]
    ];
    html += '<section class="mt-6" aria-labelledby="standing-title"><div class="mb-3 flex flex-wrap items-baseline justify-between gap-2 ' + ANIM + '" style="--i:' + i++ + '"><h2 class="text-sm font-semibold" id="standing-title">Standing in the guild</h2>' +
      (m.previousLabel ? '<p class="text-xs ' + MUTED + '">Changes are since ' + esc(m.previousLabel) + '.</p>' : '<p class="text-xs ' + MUTED + '">' + (state.dirs.length > 1 ? 'This is the first snapshot, so there is nothing earlier to compare it with.' : 'Changes and growth badges appear once a second snapshot is added.') + '</p>') + '</div>' +
      '<div class="grid gap-3 sm:grid-cols-2 sm:gap-4 lg:grid-cols-4">';
    standing.forEach(function (s) {
      var pct = s[2] != null && n > 0 ? (n - s[2] + 1) / n : 0;
      html += '<div class="' + CARD + ' p-4 ' + ANIM + '" style="--i:' + i++ + '">' +
        '<div class="flex items-center justify-between gap-2"><p class="text-sm font-medium ' + MUTED + '">' + s[1] + '</p>' + icon(s[0], 'size-4 ' + MUTED) + '</div>' +
        '<p class="mt-2 flex items-baseline gap-1.5"><span class="text-3xl font-semibold tracking-tight">' + (s[2] != null ? esc(ordinal(s[2])) : '-') + '</span><span class="text-sm ' + MUTED + '">of ' + n + '</span></p>' +
        '<p class="mt-1 flex items-baseline gap-2 text-sm"><span class="font-medium">' + esc(s[3] != null ? s[3] : '-') + '</span>' + deltaHTML(s[4]) + '</p>' +
        '<div class="mt-3">' + meter(pct, 'bg-zinc-900 dark:bg-zinc-100') + '</div></div>';
    });
    html += '</div></section>';

    var focus = focusCard(p, i++);
    html += '<div class="mt-6 grid gap-4 lg:grid-cols-6">' +
      (focus ? '<div class="lg:col-span-3">' + focus + '</div>' : '') +
      '<div class="empty:hidden ' + (focus ? 'lg:col-span-3' : 'lg:col-span-6') + '" id="readiness">' + (timeline ? readinessCard(p, timeline, i) : '') + '</div>' +
      [rivalsCard(p, ++i), damageCard(p, ++i), contributionCard(p, ++i)].filter(Boolean).map(function (c) { return '<div class="lg:col-span-2">' + c + '</div>'; }).join('') +
      '</div>';
    i++;

    if (p.profile) {
      var borrowed = pr.snapshot && pr.snapshot !== m.dir;
      if (borrowed) html += '<p class="mt-6 flex items-center gap-2 text-xs ' + MUTED + ' ' + ANIM + '" style="--i:' + i++ + '">' + icon('clock', 'size-3.5') + 'No profile capture in this snapshot. Class, stats and upgrades below are from ' + esc(fmtDay(pr.snapshot)) + '; power and contributions are current.</p>';
      html += '<div class="' + (borrowed ? 'mt-3' : 'mt-6') + ' grid gap-4 lg:grid-cols-2">';
      var stats = [['atk', 'Attack', 'sword', 'bg-red-500'], ['def', 'Defense', 'shield', 'bg-blue-500'], ['hp', 'HP', 'heart', 'bg-emerald-500'], ['spd', 'Speed', 'bolt', 'bg-amber-500']];
      html += '<section class="' + CARD + ' ' + ANIM + '" style="--i:' + i++ + '"><div class="border-b border-zinc-200/70 p-5 dark:border-white/10"><h2 class="text-base font-semibold">Combat stats</h2><p class="text-sm ' + MUTED + '">Bars are relative to the best value in the guild.' + (was ? ' Changes are since the ' + esc(fmtDay(was.snapshot)) + ' capture.' : '') + '</p></div>' +
        '<div class="divide-y divide-zinc-200/60 px-5 dark:divide-white/5">';
      stats.forEach(function (s) {
        var v = p.stat_n[s[0]], max = m.statMax[s[0]];
        var w = max > 0 && v != null ? v / max : 0;
        var ck = classKey(p), cavg = m.classAvg[ck] ? m.classAvg[ck][s[0]] : null;
        var classBest = v != null && p.cpos && p.cpos[s[0]] === 1 && p.classSize >= 2 && v !== max;
        var tick = cavg != null && max > 0 ? Math.min(100, Math.round(100 * cavg / max)) : null;
        html += '<div class="flex items-start gap-3 py-4">' +
          '<span class="mt-0.5 grid size-8 shrink-0 place-items-center rounded-md bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">' + icon(s[2], 'size-4') + '</span>' +
          '<div class="min-w-0 flex-1">' +
          '<div class="flex items-center justify-between gap-3"><span class="text-sm font-medium">' + s[1] + '</span>' +
          '<span class="flex items-center gap-2">' + (was ? deltaHTML(fmtDelta(v, parseNum((was.stats || {})[s[0]]))) : '') + '<span class="text-base font-semibold tabular-nums">' + esc(st[s[0]] || '-') + '</span>' +
          (classBest ? classBadge(p, 'Best ' + esc(pr['class'])) : '') +
          (v != null && v === max ? '<span class="inline-flex items-center gap-1 rounded-md border border-emerald-200 bg-emerald-50 px-1.5 py-0.5 text-[11px] font-medium text-emerald-700 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300">' + icon('trophy', 'size-3') + 'Guild best</span>' : '') +
          '</span></div>' +
          '<div class="relative mt-2.5">' + meter(w, s[3]) +
          (tick != null ? '<span class="absolute -top-1 h-3.5 w-0.5 rounded-full bg-zinc-400 dark:bg-zinc-500" style="left:' + tick + '%" title="' + esc(pr['class']) + ' average"></span>' : '') + '</div>' +
          '<div class="mt-1.5 flex justify-between gap-3 text-xs ' + MUTED + '">' +
          (cavg != null && ck !== 'unknown' ? '<span>' + esc(pr['class']) + ' average <b class="font-medium text-zinc-700 dark:text-zinc-200">' + esc(fmtNum(cavg)) + '</b></span>' : '<span></span>') +
          (max > 0 ? '<span>Guild best <b class="font-medium text-zinc-700 dark:text-zinc-200">' + esc(fmtNum(max)) + '</b></span>' : '') +
          '</div></div></div>';
      });
      html += '</div></section>';

      html += '<section class="' + CARD + ' ' + ANIM + '" style="--i:' + i++ + '"><div class="border-b border-zinc-200/70 p-5 dark:border-white/10"><h2 class="text-base font-semibold">Upgrades</h2><p class="text-sm ' + MUTED + '">Equipment enhancement and technique and charm levels.</p></div>' +
        '<div class="space-y-5 p-5">' +
        upgradeGroup(p, 'Equip', pr.gear || [], 5, ['blade', 'tome', 'belt', 'armor', 'boots'], '+', 'grid-cols-5', 'gear', was && was.gear) +
        upgradeGroup(p, 'Technique', pr.technique || [], 4, ['spark', 'spark', 'spark', 'spark'], 'Lv. ', 'grid-cols-4', 'tech', was && was.technique) +
        upgradeGroup(p, 'Charm', pr.charm || [], 4, ['rune', 'rune', 'rune', 'rune'], 'Lv. ', 'grid-cols-4', 'charm', was && was.charm) +
        '</div></section></div>';
      if (pr.notes) html += '<p class="mt-4 rounded-xl border border-white/70 bg-white/50 p-4 text-sm backdrop-blur-md ' + MUTED + ' dark:border-white/10 dark:bg-zinc-900/40 ' + ANIM + '" style="--i:' + i++ + '">' + esc(pr.notes) + '</p>';
    } else {
      html += '<p class="mt-6 rounded-xl border border-white/70 bg-white/50 p-4 text-sm backdrop-blur-md ' + MUTED + ' dark:border-white/10 dark:bg-zinc-900/40">No profile capture for this player yet. Only the roster line is known.</p>';
    }

    app.innerHTML = html;
    setDock('<div class="mx-auto flex max-w-6xl items-center gap-2 px-4 py-2 pb-[calc(env(safe-area-inset-bottom,0px)+8px)]">' +
      '<a class="' + BTN + '" href="' + esc(link('rankings')) + '" aria-label="All rankings">' + icon('back', 'size-4') + '</a>' +
      (prev ? '<a class="' + BTN + ' min-w-0 flex-1 justify-center" href="' + esc(link(prev.slug)) + '">' + icon('back', 'size-4') + '<span class="truncate">' + esc(prev.name) + '</span></a>' : '<span class="' + BTN + ' flex-1 justify-center opacity-40">First</span>') +
      (next ? '<a class="' + BTN + ' min-w-0 flex-1 justify-center" href="' + esc(link(next.slug)) + '"><span class="truncate">' + esc(next.name) + '</span>' + icon('next', 'size-4') + '</a>' : '<span class="' + BTN + ' flex-1 justify-center opacity-40">Last</span>') +
      '</div>');
    animateMeters();
    bindShots();
    if (!timeline) loadTimeline().then(function (t) {
      var box = document.getElementById('readiness');
      if (!box || state.meta !== m || location.hash.indexOf(p.slug) === -1) return;
      box.innerHTML = readinessCard(p, t, 3);
      animateMeters();
    }).catch(function () {});
    countUp(document.getElementById('hero-power'), p.power_n, p.power || '-');
    document.title = p.name + ' | ' + m.guild;
  }

  // before holds the same slots from the earlier capture, when there is one.
  function upgradeGroup(p, title, values, count, icons, prefix, cols, key, before) {
    var m = state.meta, ck = classKey(p);
    var avg = p.stat_n[key], max = m.statMax[key];
    var cavg = ck !== 'unknown' && m.classAvg[ck] ? m.classAvg[ck][key] : null;
    var w = max > 0 && avg != null ? avg / max : 0;
    var tick = cavg != null && max > 0 ? Math.min(100, Math.round(100 * cavg / max)) : null;
    var fmt = function (v) { return prefix + Math.round(v); };
    var html = '<div><div class="flex items-center justify-between gap-3"><h3 class="text-sm font-medium">' + title + '</h3>' +
      '<span class="flex items-center gap-2">' + (before && avg != null && p.prev ? deltaHTML(gain(Math.round(avg), p.prev.stat_n[key] != null ? Math.round(p.prev.stat_n[key]) : null)) : '') + '<span class="text-base font-semibold tabular-nums">' + (avg != null ? 'Avg ' + fmt(avg) : '-') + '</span>' +
      (avg != null && avg === max ? '<span class="inline-flex items-center gap-1 rounded-md border border-emerald-200 bg-emerald-50 px-1.5 py-0.5 text-[11px] font-medium text-emerald-700 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300">' + icon('trophy', 'size-3') + 'Guild best</span>' : '') +
      '</span></div>' +
      '<div class="mt-2.5 grid ' + cols + ' gap-2">';
    for (var k = 0; k < count; k++) {
      var v = values[k];
      html += '<div class="rounded-lg border border-zinc-200/70 bg-white/40 p-2 text-center transition-colors hover:bg-white/80 dark:border-white/10 dark:bg-white/5 dark:hover:bg-white/10">' +
        icon(icons[k], 'mx-auto size-4 ' + MUTED) +
        '<p class="mt-1 text-xs font-semibold tabular-nums' + (v == null ? ' ' + MUTED : '') + '">' + (v != null ? esc((prefix === '+' ? '' : prefix) + v) : '-') + '</p>' +
        (before ? '<p class="h-4 text-[11px] font-medium text-emerald-600 dark:text-emerald-400">' + esc(gain(intOf(v), intOf(before[k])).replace(/^-.*/, '')) + '</p>' : '') + '</div>';
    }
    html += '</div>';
    if (avg != null && max > 0) {
      html += '<div class="relative mt-3">' + meter(w, 'bg-zinc-900 dark:bg-zinc-100') +
        (tick != null ? '<span class="absolute -top-1 h-3.5 w-0.5 rounded-full bg-zinc-400 dark:bg-zinc-500" style="left:' + tick + '%" title="' + esc(p.profile['class']) + ' average"></span>' : '') + '</div>' +
        '<div class="mt-1.5 flex justify-between gap-3 text-xs ' + MUTED + '">' +
        (cavg != null ? '<span>' + esc(p.profile['class']) + ' average <b class="font-medium text-zinc-700 dark:text-zinc-200">' + fmt(cavg) + '</b></span>' : '<span></span>') +
        '<span>Guild best <b class="font-medium text-zinc-700 dark:text-zinc-200">' + fmt(max) + '</b></span></div>';
    } else if (!values.length) {
      html += '<p class="mt-2 text-xs ' + MUTED + '">Not captured.</p>';
    }
    return html + '</div>';
  }

  // Back link and, on wide screens, the neighbours in the current sort order.
  function topBar(slug, prev, next, i) {
    return '<div class="mb-4 flex items-center justify-between gap-2 ' + ANIM + '" style="--i:' + i + '">' +
      '<a class="' + GHOST + ' -ml-3" href="' + esc(link('rankings')) + '">' + icon('back', 'size-4') + 'All rankings</a>' +
      '<div class="hidden gap-2 sm:flex">' + navBtn(prev, 'back', 'Previous') + navBtn(next, 'next', 'Next') + '</div></div>';
  }

  function navBtn(target, ic, label) {
    var inner = ic === 'back' ? icon(ic, 'size-4') + label : label + icon(ic, 'size-4');
    if (!target) return '<span class="' + BTN + ' pointer-events-none opacity-40">' + inner + '</span>';
    return '<a class="' + BTN + '" href="' + esc(link(target.slug)) + '" title="' + esc(target.name) + '">' + inner + '</a>';
  }

  function renderNotFound(slug) {
    app.innerHTML = pastNotice(slug) + topBar(slug, null, null, 0) +
      '<p class="rounded-xl border border-white/70 bg-white/50 p-4 text-sm backdrop-blur-md ' + MUTED + ' dark:border-white/10 dark:bg-zinc-900/40">No player called "' + esc(slug) + '" in this snapshot. They may have joined later, left the guild or been renamed.</p>';
    setDock('');
    document.title = 'Player not found | ' + state.meta.guild;
  }

  // ---- timeline ----------------------------------------------------------------
  // Server content schedule counted from the opening date (day 1). Data lives
  // in data/timeline.json; the weekly Treasure Hunt events are generated here.

  var timeline = null;

  function loadTimeline() {
    if (timeline) return Promise.resolve(timeline);
    return fetchJSON('data/timeline.json').then(function (t) { timeline = t; return t; });
  }

  function tlStart(t) { var a = t.start.split('-').map(Number); return new Date(a[0], a[1] - 1, a[2]); }
  function tlToday(t) {
    var now = new Date(), s = tlStart(t);
    return Math.round((new Date(now.getFullYear(), now.getMonth(), now.getDate()) - s) / 86400000) + 1;
  }
  function tlDate(t, day) { var d = tlStart(t); d.setDate(d.getDate() + day - 1); return d; }
  function tlRegionAt(t, day) {
    var r = null;
    t.regions.forEach(function (x) { if (day >= x.day) r = x; });
    return r;
  }
  function tlEntries(t) {
    var list = t.entries.slice();
    var th = t.treasureHunt, maxDay = Math.max(tlToday(t), Math.max.apply(null, t.entries.map(function (e) { return e.day; })));
    var second = [0, 0, 0];
    for (var i = 0; th.firstDay + i * th.every <= maxDay + th.every; i++) {
      var day = th.firstDay + i * th.every, region = tlRegionAt(t, day), tier = region ? region.tier : 0, rot = i % 4, prize;
      if (rot === 0) prize = th.relicSelect;
      else if (rot === 1) prize = th.special1[th.tierSpecial[tier]];
      else if (rot === 2) prize = th.skillShard[tier];
      else prize = th.special2[th.tierSpecial[tier]];
      var items = [th.name + ' (' + (i + 1) + ') (' + prize + ')'];
      if (i >= 1) { var k = (i - 1) % 3; second[k]++; items.push(th.second[k] + ' (' + second[k] + ')'); }
      list.push({ day: day, category: 'Event', items: items });
    }
    var order = { 'Region': 1, 'Job change': 2, 'Dungeon': 3, 'Zone': 4, 'Seasonal map': 5, 'Ancient relic': 6, 'Relic': 6, 'Pet': 7, 'Phantasm': 8, 'Content': 9, 'Companion': 10, 'Event': 11 };
    list.sort(function (a, b) { return a.day - b.day || (order[a.category] || 99) - (order[b.category] || 99); });
    return list;
  }

  var CAT_STYLE = {
    'Region': 'bg-violet-600 text-white',
    'Job change': 'bg-amber-100 text-amber-800 dark:bg-amber-500/15 dark:text-amber-300',
    'Dungeon': 'bg-sky-100 text-sky-800 dark:bg-sky-500/15 dark:text-sky-300',
    'Seasonal map': 'bg-emerald-100 text-emerald-800 dark:bg-emerald-500/15 dark:text-emerald-300',
    'Ancient relic': 'bg-rose-100 text-rose-800 dark:bg-rose-500/15 dark:text-rose-300',
    'Relic': 'bg-rose-100 text-rose-800 dark:bg-rose-500/15 dark:text-rose-300',
    'Pet': 'bg-pink-100 text-pink-800 dark:bg-pink-500/15 dark:text-pink-300',
    'Phantasm': 'bg-indigo-100 text-indigo-800 dark:bg-indigo-500/15 dark:text-indigo-300',
    'Content': 'bg-teal-100 text-teal-800 dark:bg-teal-500/15 dark:text-teal-300',
    'Companion': 'bg-lime-100 text-lime-800 dark:bg-lime-500/15 dark:text-lime-300',
    'Event': 'bg-orange-100 text-orange-800 dark:bg-orange-500/15 dark:text-orange-300',
    'Zone': 'bg-zinc-100 text-zinc-700 dark:bg-zinc-700 dark:text-zinc-200'
  };
  var REGION_STYLE = ['border-emerald-400', 'border-amber-400', 'border-sky-400', 'border-violet-400', 'border-rose-400'];

  function catBadge(c) {
    return '<span class="inline-flex shrink-0 items-center rounded-md px-1.5 py-0.5 text-[11px] font-semibold ' + (CAT_STYLE[c] || CAT_STYLE.Zone) + '">' + esc(c) + '</span>';
  }

  function fmtItem(text) {
    return esc(text).replace(/\(([^)]+)\)/g, ' <span class="' + MUTED + '">($1)</span>');
  }

  function fmtLong(d) { return d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' }); }

  function relDay(diff) {
    if (diff === 0) return 'Today';
    if (diff === 1) return 'Tomorrow';
    if (diff === -1) return 'Yesterday';
    return diff > 0 ? 'in ' + diff + ' days' : Math.abs(diff) + ' days ago';
  }

  function comingUp(t, count) {
    var today = tlToday(t);
    var next = tlEntries(t).filter(function (e) { return e.day >= today; }).slice(0, count);
    if (!next.length) return '';
    var html = '<section class="' + CARD + ' p-5 ' + ANIM + '" style="--i:5" aria-label="Coming up">' +
      '<div class="flex items-center justify-between gap-3"><div><h2 class="text-base font-semibold">Coming up</h2>' +
      '<p class="text-sm ' + MUTED + '">Day ' + today + ' on ' + esc(m_server()) + '. Next unlocks from the server timeline.</p></div>' +
      '<a class="' + BTN + ' shrink-0" href="' + esc(link('timeline')) + '">Full timeline' + icon('next', 'size-4') + '</a></div>' +
      '<ul class="mt-4 divide-y divide-zinc-200/60 dark:divide-white/5">';
    next.forEach(function (e) {
      html += '<li class="flex items-start gap-3 py-2.5 text-sm"><span class="w-20 shrink-0 text-xs ' + MUTED + '"><b class="block font-semibold text-zinc-800 dark:text-zinc-100">' + relDay(e.day - today) + '</b>Day ' + e.day + '</span>' +
        catBadge(e.category) + '<span class="min-w-0">' + e.items.map(fmtItem).join('<br>') + '</span></li>';
    });
    return html + '</ul></section>' + currentDungeon(t);
  }

  // Dungeons on the timeline are "Name - Difficulty (Power: X)" items. The
  // current one is the latest to have opened; entries that add a difficulty to
  // the same dungeon later (an Abyss tier, say) are folded into it.
  function tlDungeons(t) {
    var out = [];
    t.entries.forEach(function (e) {
      if (e.category !== 'Dungeon') return;
      e.items.forEach(function (item) {
        var m = /^(.*?)\s+-\s+([^(]+?)\s*(?:\((.*)\))?$/.exec(item);
        if (!m) return;
        var name = m[1], last = out[out.length - 1];
        if (!last || last.name !== name) { last = { name: name, day: e.day, tiers: [] }; out.push(last); }
        last.tiers.push({ diff: m[2], req: m[3] ? m[3].replace(/^Power:\s*/, '') : '', day: e.day });
      });
    });
    return out;
  }

  function currentDungeon(t) {
    var today = tlToday(t), all = tlDungeons(t), cur = null, next = null;
    all.forEach(function (d) { if (d.day <= today) cur = d; else if (!next) next = d; });
    if (!cur) return '';
    var html = '<section class="' + CARD + ' relative overflow-hidden p-5 ' + ANIM + '" style="--i:6" aria-label="Current dungeon">' +
      deco('dungeon', 'absolute -bottom-2 right-3 hidden h-32 lg:block') +
      '<div class="flex items-start justify-between gap-3"><div class="min-w-0"><h2 class="text-base font-semibold">Current dungeon</h2>' +
      '<p class="text-sm ' + MUTED + '">Opened day ' + cur.day + ', ' + fmtLong(tlDate(t, cur.day)) + '. ' + (cur.day === today ? 'New today.' : (today - cur.day) + ' days in.') + '</p></div>' +
      catBadge('Dungeon') + '</div>' +
      '<p class="mt-3 text-2xl font-semibold tracking-tight">' + esc(cur.name) + '</p>' +
      '<ul class="mt-3 divide-y divide-zinc-200/60 text-sm dark:divide-white/5' + (DECO.dungeon ? ' lg:mr-48' : '') + '">';
    cur.tiers.forEach(function (x) {
      var late = x.day > cur.day && x.day <= today, soon = x.day > today;
      html += '<li class="flex items-center justify-between gap-3 py-2"><span class="font-medium' + (soon ? ' ' + MUTED : '') + '">' + esc(x.diff) +
        (late ? ' <span class="text-xs font-normal ' + MUTED + '">added day ' + x.day + '</span>' : '') +
        (soon ? ' <span class="text-xs font-normal">' + relDay(x.day - today) + '</span>' : '') + '</span>' +
        '<span class="shrink-0 tabular-nums ' + MUTED + '">' + (x.req ? esc(x.req) : 'No requirement') + '</span></li>';
    });
    html += '</ul>';
    if (next) html += '<p class="mt-3 border-t border-zinc-200/70 pt-3 text-sm dark:border-white/10"><span class="' + MUTED + '">Next:</span> <b class="font-semibold">' + esc(next.name) + '</b> <span class="' + MUTED + '">' + relDay(next.day - today) + ', day ' + next.day + '</span></p>';
    return html + '</section>';
  }

  function m_server() { return state.meta.server || 'the server'; }

  function renderTimeline(t) {
    var today = tlToday(t), list = tlEntries(t), region = tlRegionAt(t, today);
    var i = 0;
    var html = '<section class="mb-5 flex flex-wrap items-end justify-between gap-4 ' + ANIM + '" style="--i:' + i++ + '" aria-label="Timeline">' +
      '<div class="min-w-0"><p class="text-xs font-medium uppercase tracking-wide ' + MUTED + '">' + esc(m_server()) + ' server timeline</p>' +
      '<h1 class="mt-0.5 text-3xl font-semibold tracking-tight sm:text-4xl">Day ' + today + '</h1>' +
      '<p class="mt-1 text-sm ' + MUTED + '">Opened ' + fmtLong(tlStart(t)) + ' ' + tlStart(t).getFullYear() + '. ' + (region ? 'Currently in ' + esc(region.name) + ', day ' + (today - region.day + 1) + ' of the region.' : '') + '</p></div>' +
      deco('timeline', 'hidden h-36 w-auto -my-4 mr-4 self-end lg:block') + '</section>';

    // Region strip
    html += '<section class="' + CARD + ' mb-4 p-4 ' + ANIM + '" style="--i:' + i++ + '" aria-label="Regions"><div class="flex gap-2 overflow-x-auto pb-1">';
    t.regions.forEach(function (r, k) {
      var open = today >= r.day, cur = region && region.name === r.name;
      html += '<div class="flex min-w-[9.5rem] shrink-0 flex-col rounded-xl border-l-4 ' + REGION_STYLE[r.tier] + ' bg-white/60 px-3 py-2 dark:bg-white/5' + (cur ? ' ring-2 ring-zinc-900/80 dark:ring-white/70' : '') + (open ? '' : ' opacity-60') + '">' +
        '<span class="text-xs ' + MUTED + '">Region ' + (k + 1) + (cur ? ', current' : open ? ', open' : '') + '</span><span class="font-semibold">' + esc(r.name) + '</span>' +
        '<span class="text-xs ' + MUTED + '">Day ' + r.day + ', ' + fmtLong(tlDate(t, r.day)) + '</span></div>';
    });
    html += '</div></section>';

    // Day groups
    var past = list.filter(function (e) { return e.day < today; }), future = list.filter(function (e) { return e.day >= today; });
    function groups(entries, stagger) {
      var out = '', last = null, region = null;
      entries.forEach(function (e) {
        var r = tlRegionAt(t, e.day), tone = r ? REGION_STYLE[r.tier] : 'border-zinc-300';
        if (e.day !== last) {
          if (last !== null) out += '</div></div>';
          var diff = e.day - today;
          out += '<div class="flex gap-4 ' + (stagger ? ANIM : '') + '" style="--i:' + Math.min(stagger ? i++ : 0, 14) + '">' +
            '<div class="w-24 shrink-0 pt-3 text-right sm:w-28"><p class="text-sm font-semibold' + (diff === 0 ? ' text-emerald-600 dark:text-emerald-400' : '') + '">' + relDay(diff) + '</p>' +
            '<p class="text-xs ' + MUTED + '">Day ' + e.day + '</p><p class="text-xs ' + MUTED + '">' + fmtLong(tlDate(t, e.day)) + '</p></div>' +
            '<div class="min-w-0 flex-1 space-y-2 border-l-2 ' + tone + ' pb-4 pl-4">';
          last = e.day;
        }
        out += '<div class="' + CARD + ' flex items-start gap-3 px-4 py-3' + (e.category === 'Region' ? ' bg-violet-50/70 dark:bg-violet-500/10' : '') + '">' + catBadge(e.category) +
          '<div class="min-w-0 text-sm ' + (e.category === 'Region' ? 'font-semibold' : '') + '">' + e.items.map(fmtItem).join('<br>') + '</div></div>';
      });
      if (last !== null) out += '</div></div>';
      return out;
    }
    html += '<section aria-label="Schedule">';
    if (past.length) {
      html += '<details class="group mb-4 ' + ANIM + '" style="--i:' + i++ + '"><summary class="' + BTN + ' cursor-pointer list-none select-none">' + icon('down', 'size-4 transition-transform group-open:rotate-180') + 'Show the ' + past.length + ' earlier unlocks</summary><div class="mt-4">' + groups(past, false) + '</div></details>';
    }
    html += '<div class="mb-4 flex items-center gap-3 ' + ANIM + '" style="--i:' + i++ + '"><span class="h-px flex-1 bg-emerald-500/40"></span><span class="rounded-full bg-emerald-600 px-3 py-1 text-xs font-semibold text-white shadow-md">Today, day ' + today + '</span><span class="h-px flex-1 bg-emerald-500/40"></span></div>';
    html += groups(future, true) + '</section>';
    html += '<p class="mt-6 text-xs ' + MUTED + '">Schedule adapted from <a class="underline underline-offset-2" href="https://qenu.github.io/ethna-timeline/?start=20260703&lang=en" target="_blank" rel="noopener">Ethna Timeline</a> by Nayuta. Days count from the server opening, and dates are in your local time zone.</p>';
    app.innerHTML = html;
    setDock('');
    document.title = 'Timeline | ' + state.meta.guild;
  }

  // ---- routing ---------------------------------------------------------------

  // The timeline day is computed from the viewer's clock at render time, so a
  // tab left open past midnight is re-rendered when the day ticks over.
  var shownDay = null;
  setInterval(function () {
    if (!timeline) return;
    var d = tlToday(timeline);
    if (shownDay === null) { shownDay = d; return; }
    if (d !== shownDay) { shownDay = d; route(); }
  }, 60000);

  // Loads a snapshot and the one before it (for the changes), then makes it
  // the one on screen. Resolves false when a later request has overtaken it.
  var loadSeq = 0;
  function openSnapshot(dir) {
    var at = state.dirs.indexOf(dir), seq = ++loadSeq;
    return Promise.all([loadSnapshot(dir), at > 0 ? loadSnapshot(state.dirs[at - 1]) : null]).then(function (res) {
      if (seq !== loadSeq) return false;
      prepare(res[0], res[1]);
      return true;
    });
  }

  function route() {
    var hash = decodeURIComponent(location.hash.replace(/^#\/?/, ''));
    var dated = /^(\d{4}-\d{2}-\d{2})(?:\/(.*))?$/.exec(hash);
    var slug = dated ? dated[2] || '' : hash;
    // An unknown date falls back to the latest snapshot. The timeline is not
    // tied to a snapshot, so it keeps whichever one is open.
    var dir = state.latest;
    if (dated && state.dirs.indexOf(dated[1]) !== -1) dir = dated[1];
    else if (slug === 'timeline' && state.meta) dir = state.meta.dir;
    if (!state.meta || state.meta.dir !== dir) {
      openSnapshot(dir).then(function (ok) { if (ok) show(slug); }).catch(function (err) {
        if (!state.meta) { fail(err); return; }
        setDock('');
        app.innerHTML = '<div class="mb-4"><a class="' + GHOST + ' -ml-3" href="#">' + icon('back', 'size-4') + 'Latest dashboard</a></div>' +
          '<p class="rounded-xl border border-white/70 bg-white/50 p-4 text-sm backdrop-blur-md ' + MUTED + ' dark:border-white/10 dark:bg-zinc-900/40">Could not load the snapshot from ' + esc(fmtDay(dir)) + '. ' + esc(err && err.message) + '</p>';
      });
      return;
    }
    show(slug);
  }

  function show(slug) {
    renderNav(slug);
    if (!slug) { setDock(''); renderDashboard(); window.scrollTo(0, 0); return; }
    if (slug === 'rankings') { setDock(''); renderRankings(); window.scrollTo(0, 0); return; }
    if (slug === 'timeline') {
      loadTimeline().then(renderTimeline).catch(function (err) { setDock(''); app.innerHTML = '<p class="rounded-xl border border-white/70 bg-white/50 p-4 text-sm backdrop-blur-md ' + MUTED + '">Could not load the timeline. ' + esc(err && err.message) + '</p>'; });
      window.scrollTo(0, 0); return;
    }
    var p = state.players.filter(function (x) { return x.slug === slug; })[0];
    if (p) renderProfile(p); else renderNotFound(slug);
    window.scrollTo(0, 0);
  }

  function fail(err) {
    document.getElementById('loading').hidden = true;
    var box = document.getElementById('error');
    box.hidden = false;
    var local = location.protocol === 'file:';
    box.textContent = (err && err.message ? err.message : 'Could not load guild data.') +
      (local ? ' Browsers block reading JSON from a file:// address. Serve the folder with a local web server, or open the GitHub Pages site.' : '');
  }

  fetchJSON('data/snapshots.json').then(function (dirs) {
    dirs = dirs.slice().sort();
    if (!dirs.length) throw new Error('data/snapshots.json lists no snapshots.');
    state.dirs = dirs;
    state.latest = dirs[dirs.length - 1];
    window.addEventListener('hashchange', route);
    route();
  }).catch(fail);
})();
