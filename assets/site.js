/* Zenith guild tracker. Reads data/snapshots/<date>/{week,profiles}.json and
   renders the rankings dashboard and per-player profiles. No build step.
   Routes: "#" is the rankings, "#<slug>" is one player. */
(function () {
  'use strict';

  var app = document.getElementById('app');
  var dock = document.getElementById('dock');
  var state = { meta: null, players: [], sortKey: 'power_n', sortDir: 'desc', query: '', classFilter: null };
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

  function loadSnapshot(dir) {
    var base = 'data/snapshots/' + dir + '/';
    return Promise.all([
      fetchJSON(base + 'week.json'),
      fetchJSON(base + 'profiles.json').catch(function () { return { profiles: [] }; })
    ]).then(function (res) {
      var week = res[0], profiles = res[1];
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
    });
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
      p.growth = {
        power: prev && prev.power_n != null && p.power_n != null ? p.power_n - prev.power_n : null,
        places: prevPos[p.name] && p.pos.power_n ? prevPos[p.name] - p.pos.power_n : null,
        rank: null
      };
    });
    var gainers = players.filter(function (p) { return p.growth.power != null; })
      .sort(function (a, b) { return b.growth.power - a.growth.power; });
    gainers.forEach(function (p, i) { p.growth.rank = i + 1; });

    var sum = function (m) { return players.reduce(function (a, p) { return a + (p[m] || 0); }, 0); };
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
      capturedDate: fmtDate(current.capturedAt),
      previousLabel: previous ? previous.label : null,
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
  var SHADOW = '[text-shadow:0_1px_3px_rgba(0,0,0,.55)]';

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
    return 'data/snapshots/' + state.meta.dir + '/avatars/' + String(pr.file).replace(/\.png$/i, '') + '.webp';
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
    return 'data/snapshots/' + state.meta.dir + '/shots/' + String(pr.file).replace(/\.png$/i, '') + '.webp';
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
    [['power_n', 'power'], ['dmg_n', 'conquest damage'], ['total_n', 'total contribution'], ['week_n', 'weekly contribution']].forEach(function (m) {
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
      '<p class="flex items-baseline gap-2"><span class="text-xl font-semibold tracking-tight"' + (n != null ? ' data-count="' + n + '"' : '') + '>' + esc(value) + '</span>' +
      (hint ? '<span class="text-xs ' + MUTED + '">' + esc(hint) + '</span>' : '') + '</p></div></div>';
  }

  function renderRankings() {
    var m = state.meta;
    var html = '<section class="mb-6 flex flex-wrap items-center gap-4 pt-2 text-white sm:gap-5 sm:pt-6 ' + ANIM + '" style="--i:0" aria-label="Guild">' +
      '<img class="size-16 shrink-0 rounded-xl shadow-lg ring-1 ring-white/20 sm:size-20" src="assets/img/logo/zenith-160.webp" alt="" decoding="async">' +
      '<div class="min-w-0 flex-1"><p class="text-xs font-medium uppercase tracking-wide text-zinc-200 [text-shadow:0_1px_2px_rgba(0,0,0,.5)]">Sword x Staff guild on ' + esc(m.server || 'an unknown server') + '</p>' +
      '<h1 class="mt-0.5 text-3xl font-semibold tracking-tight [text-shadow:0_1px_3px_rgba(0,0,0,.5)] sm:text-4xl">' + esc(m.guild) + '</h1>' +
      '<p class="mt-1 text-sm text-zinc-200 [text-shadow:0_1px_2px_rgba(0,0,0,.5)]">' + esc(m.memberCount + ' members. ' + m.label + ', captured ' + m.capturedDate + '.') + '</p></div>' +
      deco('hero', 'hidden h-44 w-auto -my-12 mr-2 self-end drop-shadow-[0_12px_24px_rgba(0,0,0,.45)] lg:block') +
      '<div class="flex basis-full gap-2 sm:basis-auto">' +
      '<a class="' + BTN + ' flex-1 justify-center rounded-md sm:flex-none" href="#timeline">' + icon('clock', 'size-4') + 'Timeline</a>' +
      '<a class="inline-flex h-9 flex-1 shrink-0 items-center justify-center gap-1.5 rounded-md bg-[#5865F2] px-3.5 text-sm font-semibold text-white shadow-md transition-colors hover:bg-[#4752C4] sm:flex-none" href="https://discord.gg/fapjXcFYhw" target="_blank" rel="noopener">' + icon('discord', 'size-4') + 'Join the Discord</a>' +
      '</div></section>';
    html += '<section class="grid grid-cols-1 gap-3 sm:grid-cols-2 sm:gap-4 lg:grid-cols-4" aria-label="Guild summary">' +
      kpi('people', m.memberCount, 'Members', 1) +
      kpi('bolt', fmtNum(m.totalPower), 'Total power', 2) +
      kpi('gem', fmtNum(m.totalWeek), 'Weekly contribution', 3) +
      kpi('swords', fmtNum(m.totalDmg), 'Conquest damage', 4) +
      '</section>';
    html += '<div class="mt-4 grid gap-3 sm:gap-4 md:grid-cols-2" id="coming-up"></div>';

    html += '<section class="' + CARD + ' mt-6 ' + ANIM + '" style="--i:5" aria-labelledby="ledger-title">' +
      '<div class="flex flex-col gap-3 border-b border-zinc-200/70 p-4 sm:flex-row sm:items-center sm:justify-between sm:p-5 dark:border-white/10">' +
      '<div><h2 class="text-base font-semibold" id="ledger-title">Guild rankings</h2>' +
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

    Array.prototype.forEach.call(app.querySelectorAll('[data-count]'), function (el) {
      countUp(el, parseFloat(el.getAttribute('data-count')), el.textContent);
    });
    animateMeters();
    loadTimeline().then(function (t) {
      var box = document.getElementById('coming-up');
      if (box) box.innerHTML = comingUp(t, 3);
    }).catch(function () {});
    document.title = m.guild + ' rankings';
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
      html += '<tr class="group cursor-pointer transition-colors hover:bg-white/60 dark:hover:bg-white/5" data-href="#' + esc(p.slug) + '">' +
        '<td class="px-3 py-3 sm:px-4">' + posBadge(shown) + '</td>' +
        '<td class="px-3 py-3 sm:px-4"><div class="flex items-center gap-3">' + avatar(p) +
        '<div class="min-w-0"><div class="flex items-center gap-2"><a class="truncate font-medium text-zinc-900 hover:underline dark:text-zinc-50" href="#' + esc(p.slug) + '">' + esc(p.name) + '</a>' + roleBadge(p) + '</div>' +
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

  // ---- rendering: profile ---------------------------------------------------

  function dl(label, value, extra) {
    return '<div><dt class="text-xs font-medium ' + MUTED + '">' + label + '</dt><dd class="mt-0.5 truncate font-medium ' + (extra || '') + '">' + value + '</dd></div>';
  }

  function meter(w, color) {
    return '<div class="meter h-1.5 w-full overflow-hidden rounded-full bg-zinc-100 dark:bg-zinc-800"><i class="' + color + '" data-w="' + Math.round(w * 100) + '"></i></div>';
  }

  function renderProfile(p) {
    var m = state.meta, pr = p.profile || {}, st = pr.stats || {}, n = m.memberCount;
    var order = sortedPlayers();
    var at = order.map(function (x) { return x.slug; }).indexOf(p.slug);
    var prev = at > 0 ? order[at - 1] : null;
    var next = at >= 0 && at < order.length - 1 ? order[at + 1] : null;
    var i = 0;

    var html = '<div class="mb-4 flex items-center justify-between gap-2 ' + ANIM + '" style="--i:' + i++ + '">' +
      '<a class="' + GHOST + ' -ml-3" href="#">' + icon('back', 'size-4') + 'All rankings</a>' +
      '<div class="hidden gap-2 sm:flex">' + navBtn(prev, 'back', 'Previous') + navBtn(next, 'next', 'Next') + '</div></div>';

    var sub = [];
    if (pr['class']) sub.push(pr['class'] + (pr.classLevel != null ? ', class level ' + pr.classLevel : ''));
    else sub.push('Class not captured');
    html += '<section class="' + CARD + ' p-5 sm:p-6 ' + ANIM + '" style="--i:' + i++ + '" aria-label="Player card">' +
      '<div class="flex flex-col gap-6 sm:flex-row sm:items-start sm:justify-between">' +
      '<div class="flex items-start gap-4">' + avatar(p, 'lg') +
      '<div class="min-w-0"><h1 class="text-2xl font-semibold tracking-tight">' + esc(p.name) + '</h1>' +
      '<p class="mt-0.5 flex flex-wrap items-center text-sm ' + MUTED + '">' + classInline(p) + (pr.classLevel != null ? '<span>, class level ' + esc(pr.classLevel) + '</span>' : '') + '</p>' +
      '<div class="mt-3 flex flex-wrap gap-1.5">' +
      (pr.level != null ? '<span class="' + BADGE + '">Level ' + esc(pr.level) + '</span>' : '') +
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
      dl('Likes', esc(pr.likes || '-')) +
      '</dl></section>';

    var standing = [
      ['swords', 'Power', p.pos.power_n, p.power, p.delta.power],
      ['gem', 'Weekly contribution', p.pos.week_n, p.week, ''],
      ['trophy', 'Total contribution', p.pos.total_n, p.total, p.delta.total],
      ['sword', 'Conquest damage', p.pos.dmg_n, p.dmg, p.delta.dmg]
    ];
    html += '<section class="mt-6" aria-labelledby="standing-title"><div class="mb-3 flex flex-wrap items-baseline justify-between gap-2 ' + ANIM + '" style="--i:' + i++ + '"><h2 class="text-sm font-semibold" id="standing-title">Standing in the guild</h2>' +
      (m.previousLabel ? '<p class="text-xs ' + MUTED + '">Changes are since ' + esc(m.previousLabel) + '.</p>' : '<p class="text-xs ' + MUTED + '">Changes and growth badges appear once a second snapshot is added.</p>') + '</div>' +
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

    if (p.profile) {
      html += '<div class="mt-6 grid gap-4 lg:grid-cols-2">';
      var stats = [['atk', 'Attack', 'sword', 'bg-red-500'], ['def', 'Defense', 'shield', 'bg-blue-500'], ['hp', 'HP', 'heart', 'bg-emerald-500'], ['spd', 'Speed', 'bolt', 'bg-amber-500']];
      html += '<section class="' + CARD + ' ' + ANIM + '" style="--i:' + i++ + '"><div class="border-b border-zinc-200/70 p-5 dark:border-white/10"><h2 class="text-base font-semibold">Combat stats</h2><p class="text-sm ' + MUTED + '">Bars are relative to the best value in the guild.</p></div>' +
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
          '<span class="flex items-center gap-2"><span class="text-base font-semibold tabular-nums">' + esc(st[s[0]] || '-') + '</span>' +
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
        upgradeGroup(p, 'Equip', pr.gear || [], 5, ['blade', 'tome', 'belt', 'armor', 'boots'], '+', 'grid-cols-5', 'gear') +
        upgradeGroup(p, 'Technique', pr.technique || [], 4, ['spark', 'spark', 'spark', 'spark'], 'Lv. ', 'grid-cols-4', 'tech') +
        upgradeGroup(p, 'Charm', pr.charm || [], 4, ['rune', 'rune', 'rune', 'rune'], 'Lv. ', 'grid-cols-4', 'charm') +
        '</div></section></div>';
      if (pr.notes) html += '<p class="mt-4 rounded-xl border border-white/70 bg-white/50 p-4 text-sm backdrop-blur-md ' + MUTED + ' dark:border-white/10 dark:bg-zinc-900/40 ' + ANIM + '" style="--i:' + i++ + '">' + esc(pr.notes) + '</p>';
    } else {
      html += '<p class="mt-6 rounded-xl border border-white/70 bg-white/50 p-4 text-sm backdrop-blur-md ' + MUTED + ' dark:border-white/10 dark:bg-zinc-900/40">No profile capture for this player yet. Only the roster line is known.</p>';
    }

    app.innerHTML = html;
    setDock('<div class="mx-auto flex max-w-6xl items-center gap-2 px-4 py-2 pb-[calc(env(safe-area-inset-bottom,0px)+8px)]">' +
      '<a class="' + BTN + '" href="#" aria-label="All rankings">' + icon('back', 'size-4') + '</a>' +
      (prev ? '<a class="' + BTN + ' min-w-0 flex-1 justify-center" href="#' + esc(prev.slug) + '">' + icon('back', 'size-4') + '<span class="truncate">' + esc(prev.name) + '</span></a>' : '<span class="' + BTN + ' flex-1 justify-center opacity-40">First</span>') +
      (next ? '<a class="' + BTN + ' min-w-0 flex-1 justify-center" href="#' + esc(next.slug) + '"><span class="truncate">' + esc(next.name) + '</span>' + icon('next', 'size-4') + '</a>' : '<span class="' + BTN + ' flex-1 justify-center opacity-40">Last</span>') +
      '</div>');
    animateMeters();
    bindShots();
    countUp(document.getElementById('hero-power'), p.power_n, p.power || '-');
    document.title = p.name + ' | ' + m.guild;
  }

  function upgradeGroup(p, title, values, count, icons, prefix, cols, key) {
    var m = state.meta, ck = classKey(p);
    var avg = p.stat_n[key], max = m.statMax[key];
    var cavg = ck !== 'unknown' && m.classAvg[ck] ? m.classAvg[ck][key] : null;
    var w = max > 0 && avg != null ? avg / max : 0;
    var tick = cavg != null && max > 0 ? Math.min(100, Math.round(100 * cavg / max)) : null;
    var fmt = function (v) { return prefix + Math.round(v); };
    var html = '<div><div class="flex items-center justify-between gap-3"><h3 class="text-sm font-medium">' + title + '</h3>' +
      '<span class="flex items-center gap-2"><span class="text-base font-semibold tabular-nums">' + (avg != null ? 'Avg ' + fmt(avg) : '-') + '</span>' +
      (avg != null && avg === max ? '<span class="inline-flex items-center gap-1 rounded-md border border-emerald-200 bg-emerald-50 px-1.5 py-0.5 text-[11px] font-medium text-emerald-700 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300">' + icon('trophy', 'size-3') + 'Guild best</span>' : '') +
      '</span></div>' +
      '<div class="mt-2.5 grid ' + cols + ' gap-2">';
    for (var k = 0; k < count; k++) {
      var v = values[k];
      html += '<div class="rounded-lg border border-zinc-200/70 bg-white/40 p-2 text-center transition-colors hover:bg-white/80 dark:border-white/10 dark:bg-white/5 dark:hover:bg-white/10">' +
        icon(icons[k], 'mx-auto size-4 ' + MUTED) +
        '<p class="mt-1 text-xs font-semibold tabular-nums' + (v == null ? ' ' + MUTED : '') + '">' + (v != null ? esc((prefix === '+' ? '' : prefix) + v) : '-') + '</p></div>';
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

  function navBtn(target, ic, label) {
    var inner = ic === 'back' ? icon(ic, 'size-4') + label : label + icon(ic, 'size-4');
    if (!target) return '<span class="' + BTN + ' pointer-events-none opacity-40">' + inner + '</span>';
    return '<a class="' + BTN + '" href="#' + esc(target.slug) + '" title="' + esc(target.name) + '">' + inner + '</a>';
  }

  function renderNotFound(slug) {
    app.innerHTML = '<div class="mb-4"><a class="' + GHOST + ' -ml-3" href="#">' + icon('back', 'size-4') + 'All rankings</a></div>' +
      '<p class="rounded-xl border border-white/70 bg-white/50 p-4 text-sm backdrop-blur-md ' + MUTED + ' dark:border-white/10 dark:bg-zinc-900/40">No player called "' + esc(slug) + '" in this snapshot. They may have left the guild or been renamed.</p>';
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
      '<a class="' + BTN + ' shrink-0" href="#timeline">Full timeline' + icon('next', 'size-4') + '</a></div>' +
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
    var html = '<section class="mb-5 flex flex-wrap items-end justify-between gap-4 pt-2 text-white sm:pt-6 ' + ANIM + '" style="--i:' + i++ + '" aria-label="Timeline">' +
      '<div class="min-w-0"><p class="text-xs font-medium uppercase tracking-wide text-zinc-200 ' + SHADOW + '">' + esc(m_server()) + ' server timeline</p>' +
      '<h1 class="mt-0.5 text-3xl font-semibold tracking-tight sm:text-4xl ' + SHADOW + '">Day ' + today + '</h1>' +
      '<p class="mt-1 text-sm text-zinc-200 ' + SHADOW + '">Opened ' + fmtLong(tlStart(t)) + ' ' + tlStart(t).getFullYear() + '. ' + (region ? 'Currently in ' + esc(region.name) + ', day ' + (today - region.day + 1) + ' of the region.' : '') + '</p></div>' +
      deco('timeline', 'hidden h-44 w-auto -my-10 ml-auto mr-4 self-end drop-shadow-[0_12px_24px_rgba(0,0,0,.45)] lg:block') +
      '<a class="' + BTN + ' rounded-full" href="#">' + icon('back', 'size-4') + 'Rankings</a></section>';

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

  function route() {
    var slug = decodeURIComponent(location.hash.replace(/^#\/?/, ''));
    document.getElementById('backdrop').hidden = !(slug === '' || slug === 'timeline');
    if (!slug) { setDock(''); renderRankings(); window.scrollTo(0, 0); return; }
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
    var current = dirs[dirs.length - 1];
    var previous = dirs.length > 1 ? dirs[dirs.length - 2] : null;
    return Promise.all([loadSnapshot(current), previous ? loadSnapshot(previous) : null]);
  }).then(function (res) {
    prepare(res[0], res[1]);
    window.addEventListener('hashchange', route);
    route();
  }).catch(fail);
})();
