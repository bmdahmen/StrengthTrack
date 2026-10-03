/* StrengthTrack frontend */
'use strict';

function $(sel) { return document.querySelector(sel); }

function api(path, opts) {
  var headers = { 'Authorization': 'Bearer ' + (sessionToken() || '') };
  var o = Object.assign({ credentials: 'same-origin', headers: headers }, opts || {});
  if (opts && opts.headers) o.headers = Object.assign(headers, opts.headers);
  return fetch(path, o)
    .then(function (r) {
      if (r.status === 401) {
        return r.json().then(function (d) {
          if (d && d.code === 'AUTH_REQUIRED') { signOut(true); throw new Error('signed out'); }
          throw new Error('unauthorized');
        }).catch(function (e) {
          if (e.message === 'signed out') throw e;
          signOut(true); throw new Error('unauthorized');
        });
      }
      if (!r.ok) throw new Error('request failed: ' + r.status);
      return r.json();
    });
}

/* ---------- auth ---------- */

function sessionToken() { try { return localStorage.getItem('st_session'); } catch (e) { return null; } }
function sessionUser() { try { return JSON.parse(localStorage.getItem('st_user') || 'null'); } catch (e) { return null; } }
function authHeaders() { return { 'Authorization': 'Bearer ' + (sessionToken() || '') }; }

function signOut(silent) {
  var tok = sessionToken();
  try { localStorage.removeItem('st_session'); localStorage.removeItem('st_user'); } catch (e) {}
  cache.workouts = null; cache.exercises = null; coachCache = {};
  if (tok && !silent) fetch('/api/auth/logout', { method: 'POST', headers: { 'Authorization': 'Bearer ' + tok } }).catch(function () {});
  vLogin();
}

function vLogin() {
  var v = $('#view');
  v.innerHTML =
    '<div class="card" style="max-width:380px;margin:40px auto;text-align:center">' +
    '<div class="wdate" style="font-size:20px">StrengthTrack</div>' +
    '<div class="wmeta" style="margin:8px 0 18px">Your workout log lives in your own account.<br>Sign in with Google to continue.</div>' +
    '<div id="gsibtn" style="display:flex;justify-content:center"></div>' +
    '<div id="loginerr"></div></div>';
  loadGis(function () {
    api('/api/auth/config').then(function (cfg) {
      google.accounts.id.initialize({
        client_id: cfg.google_client_id,
        callback: handleGoogleCredential,
        auto_select: true,
      });
      google.accounts.id.renderButton(document.getElementById('gsibtn'), { theme: 'filled_blue', size: 'large' });
      // One Tap auto-prompt is a nice-to-have; on some mobile browsers it throws
      // (e.g. Safari "string did not match the expected pattern"). Never let it
      // break the login screen — the button above works on its own.
      try { google.accounts.id.prompt(); } catch (e) { /* one-tap unavailable */ }
    }).catch(function (e) {
      document.getElementById('loginerr').innerHTML = '<div class="err">' + esc(e.message) + '</div>';
    });
  });
}

var gisLoaded = false, gisQueue = [];
function loadGis(cb) {
  if (gisLoaded) { cb(); return; }
  gisQueue.push(cb);
  if (gisQueue.length > 1) return;
  var s = document.createElement('script');
  s.src = 'https://accounts.google.com/gsi/client';
  s.async = true; s.defer = true;
  s.onload = function () { gisLoaded = true; gisQueue.forEach(function (f) { f(); }); gisQueue = []; };
  s.onerror = function () { document.getElementById('loginerr').innerHTML = '<div class="err">Could not load Google sign-in.</div>'; };
  document.head.appendChild(s);
}

function handleGoogleCredential(resp) {
  fetch('/api/auth/google', {
    method: 'POST', credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: resp.credential }),
  }).then(function (r) { return r.json().then(function (d) { return { status: r.status, body: d }; }); })
    .then(function (res) {
      if (res.status !== 200 || !res.body.ok) {
        document.getElementById('loginerr').innerHTML = '<div class="err">' +
          esc(res.body.message || res.body.error || 'sign-in failed') + '</div>';
        return;
      }
      try {
        localStorage.setItem('st_session', res.body.session_token);
        localStorage.setItem('st_user', JSON.stringify(res.body.user));
      } catch (e) {}
      location.hash = '#/';
      nav();
    })
    .catch(function (e) {
      document.getElementById('loginerr').innerHTML = '<div class="err">' + esc(e.message) + '</div>';
    });
}

function paintUserChip() {
  var el = document.getElementById('userchip');
  if (!el) return;
  var u = sessionUser();
  el.innerHTML = u
    ? '<span class="uchip">' + esc(u.name || u.email || 'Account') + '</span> <a href="#" id="logoutlink">Sign out</a>'
    : '';
  var lo = document.getElementById('logoutlink');
  if (lo) lo.addEventListener('click', function (e) { e.preventDefault(); signOut(false); });
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}

function fmtDate(d) {
  var p = d.split('-'), dt = new Date(+p[0], +p[1] - 1, +p[2]);
  return dt.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}

function fmtDateFull(d) {
  var p = d.split('-'), dt = new Date(+p[0], +p[1] - 1, +p[2]);
  return dt.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
}

function setDisplay(s) {
  var t;
  if (s.bodyweight) {
    t = 'BW' + (s.added_weight_lb ? ' +' + s.added_weight_lb + ' lb' : '') + ' × ' + s.reps;
  } else if (s.unit === 'kg') {
    t = s.weight + ' kg' + (s.per_hand ? ' /hand' : '') + ' × ' + s.reps;
  } else {
    t = (s.weight != null ? s.weight + ' lb' : '?') + ' × ' + s.reps;
  }
  if (s.to_failure) t += ' <span class="F">F</span>';
  return t;
}

var SET_COLORS = ['#5eb1ff', '#ff9d5c', '#7ddb8a', '#d18bff', '#ffd35c', '#ff7d9c'];

function multiChart(series, yFmt) {
  // series: [{label, color, hidden, points:[{x:'2026-10-03', y:1.2, first:true}]}]
  // Legend entries are clickable toggles (caller wires up .lg / .mini clicks).
  var vis = series.filter(function (s) { return !s.hidden; });
  var W = 360, H = 230, L = 42, R = 10, T = 14, B = 30;
  var iw = W - L - R, ih = H - T - B;
  var dates = [], seen = {};
  vis.forEach(function (s) {
    s.points.forEach(function (p) {
      if (!seen[p.x]) { seen[p.x] = 1; dates.push(p.x); }
    });
  });
  dates.sort();
  var allY = [];
  vis.forEach(function (s) { s.points.forEach(function (p) { allY.push(p.y); }); });
  if (!allY.length) return '<div class="dim">All sets hidden — tap the legend to show a line.</div>';
  var lo = Math.min.apply(null, allY), hi = Math.max.apply(null, allY);
  if (lo === hi) { lo -= 1; hi += 1; }
  var pad = (hi - lo) * 0.15; lo -= pad; hi += pad;
  var xPos = {};
  dates.forEach(function (d, i) { xPos[d] = L + (dates.length === 1 ? iw / 2 : (i / (dates.length - 1)) * iw); });
  function Y(v) { return T + ih - ((v - lo) / (hi - lo)) * ih; }
  var svg = '';
  [lo + pad, (lo + hi) / 2, hi - pad].forEach(function (v) {
    svg += '<text x="' + (L - 5) + '" y="' + (Y(v) + 4).toFixed(1) + '" font-size="10" fill="#9aa4b2" text-anchor="end">' +
      esc(yFmt(v)) + '</text>' +
      '<line x1="' + L + '" y1="' + Y(v).toFixed(1) + '" x2="' + (W - R) + '" y2="' + Y(v).toFixed(1) + '" stroke="#262c36"/>';
  });
  var n = dates.length;
  [0, Math.floor(n / 2), n - 1].forEach(function (i) {
    svg += '<text x="' + xPos[dates[i]].toFixed(1) + '" y="' + (H - 10) + '" font-size="10" fill="#9aa4b2" text-anchor="middle">' +
      esc(shortDate(dates[i])) + '</text>';
  });
  vis.forEach(function (s) {
    var pts = s.points.slice().sort(function (a, b) { return a.x < b.x ? -1 : 1; });
    var line = pts.map(function (p) { return xPos[p.x].toFixed(1) + ',' + Y(p.y).toFixed(1); }).join(' ');
    svg += '<polyline points="' + line + '" fill="none" stroke="' + s.color + '" stroke-width="2" opacity="0.9"/>';
    pts.forEach(function (p) {
      var cx = xPos[p.x].toFixed(1), cy = Y(p.y).toFixed(1);
      if (p.first) svg += '<circle cx="' + cx + '" cy="' + cy + '" r="6" fill="none" stroke="#fff" stroke-width="1.6"/>';
      svg += '<circle cx="' + cx + '" cy="' + cy + '" r="3.4" fill="' + s.color + '">' +
        '<title>' + esc(s.label + ' · ' + p.x + ': ' + yFmt(p.y)) + (p.first ? ' · first exercise' : '') + '</title></circle>';
    });
  });
  var legend = series.map(function (s, i) {
    return '<span class="lg' + (s.hidden ? ' off' : '') + '" data-i="' + i + '">' +
      '<span style="display:inline-block; width:10px; height:10px; border-radius:50%; background:' + s.color + '; margin-right:5px"></span>' +
      '<span class="lbl">' + esc(s.label) + '</span></span>';
  }).join('');
  return '<div style="margin-bottom:8px">' + legend +
    '<span style="font-size:12px; color:#9aa4b2; margin-left:6px">○ = first of day</span>' +
    '<span style="float:right; font-size:12px"><span class="mini" data-act="all">All</span>' +
    ' <span class="dim">·</span> <span class="mini" data-act="first3">1–3</span></span></div>' +
    '<div style="clear:both"></div>' +
    '<svg class="chart" viewBox="0 0 ' + W + ' ' + H + '">' + svg + '</svg>';
}

function chart(points, yFmt) {
  // points: [{x:'2026-10-03', y:151.8}] sorted by x
  var W = 360, H = 210, L = 40, R = 10, T = 12, B = 30;
  var iw = W - L - R, ih = H - T - B;
  if (!points.length) return '<div class="dim">No data.</div>';
  var ys = points.map(function (p) { return p.y; });
  var lo = Math.min.apply(null, ys), hi = Math.max.apply(null, ys);
  if (lo === hi) { lo -= 1; hi += 1; }
  var pad = (hi - lo) * 0.15; lo -= pad; hi += pad;
  function X(i) { return L + (points.length === 1 ? iw / 2 : (i / (points.length - 1)) * iw); }
  function Y(v) { return T + ih - ((v - lo) / (hi - lo)) * ih; }
  var line = points.map(function (p, i) { return X(i).toFixed(1) + ',' + Y(p.y).toFixed(1); }).join(' ');
  var dots = points.map(function (p, i) {
    return '<circle cx="' + X(i).toFixed(1) + '" cy="' + Y(p.y).toFixed(1) + '" r="3.2" fill="#5eb1ff">' +
      '<title>' + esc(p.x) + ': ' + esc(yFmt(p.y)) + '</title></circle>';
  }).join('');
  var ticks = [lo + pad * 0, (lo + hi) / 2, hi - pad * 0].map(function (v) {
    return '<text x="' + (L - 5) + '" y="' + (Y(v) + 4).toFixed(1) + '" font-size="10" fill="#9aa4b2" text-anchor="end">' +
      esc(yFmt(v)) + '</text>' +
      '<line x1="' + L + '" y1="' + Y(v).toFixed(1) + '" x2="' + (W - R) + '" y2="' + Y(v).toFixed(1) + '" stroke="#262c36"/>';
  }).join('');
  var n = points.length;
  var xl = [points[0].x, points[Math.floor(n / 2)].x, points[n - 1].x]
    .map(function (x, i) { return '<text x="' + X(i === 0 ? 0 : (i === 1 ? Math.floor(n / 2) : n - 1)).toFixed(1) +
      '" y="' + (H - 10) + '" font-size="10" fill="#9aa4b2" text-anchor="middle">' + esc(shortDate(x)) + '</text>'; })
    .join('');
  return '<svg class="chart" viewBox="0 0 ' + W + ' ' + H + '">' + ticks +
    '<polyline points="' + line + '" fill="none" stroke="#5eb1ff" stroke-width="2"/>' + dots + xl + '</svg>';
}

function shortDate(d) {
  var p = d.split('-');
  return (+p[1]) + '/' + (+p[2]);
}

var cache = {};

function nav() {
  var h = location.hash || '#/';
  paintUserChip();
  if (!sessionToken()) { vLogin(); return; }
  document.querySelectorAll('[data-nav]').forEach(function (a) {
    var href = a.getAttribute('href');
    var on = false;
    if (href === '#/') on = (h === '#/' || h === '#/ex' || h.indexOf('#/ex/') === 0);
    else if (href === '#/wo') on = (h === '#/wo' || h.indexOf('#/w/') === 0);
    else on = h.indexOf(href) === 0;
    a.classList.toggle('on', on);
  });
  if (h === '#/' || h === '' || h === '#/ex') return vExercises('');
  var m = h.match(/^#\/w\/(\d+)$/);
  if (m) return vWorkout(m[1]);
  if (h === '#/wo') return vWorkouts();
  m = h.match(/^#\/ex\/(.+)$/);
  if (m) return vExercise(decodeURIComponent(m[1]));
  if (h === '#/wt') return vWeight();
  if (h === '#/notes') return vNotes();
  if (h === '#/log') return vLog();
  return vExercises('');
}

function vWorkouts() {
  var v = $('#view');
  v.innerHTML = '<div class="dim">Loading…</div>';
  api('/api/workouts').then(function (ws) {
    cache.workouts = ws;
    v.innerHTML = '<div class="small dim" style="margin:4px 0 8px">' + ws.length + ' workouts logged</div>' +
      ws.map(function (w) {
        var meta = [];
        if (w.title) meta.push(esc(w.title));
        if (w.body_weight_lb) meta.push(w.body_weight_lb + ' lb' + (w.body_weight_source === 'calprotrack' ? '*' : ''));
        meta.push(w.set_count + ' sets');
        if (w.duration_min) meta.push(w.duration_min + ' min');
        if (w.calories) meta.push(w.calories + ' cal');
        return '<a class="wo" href="#/w/' + w.id + '"><div class="card"><div class="row">' +
          '<div class="grow"><div class="wdate">' + fmtDate(w.date) + '</div>' +
          '<div class="wmeta">' + meta.join(' · ') + '</div></div>' +
          '<div class="dim">›</div></div></div></a>';
      }).join('') +
      '<div class="small dim">* body weight from CalProTrack</div>';
  }).catch(function (e) { v.innerHTML = '<div class="err">' + esc(e.message) + '</div>'; });
}

function vWorkout(id) {
  var v = $('#view');
  v.innerHTML = '<div class="dim">Loading…</div>';
  api('/api/workout/' + id).then(function (d) {
    var w = d.workout, sets = d.sets, cardio = d.cardio;
    var groups = [], seen = {};
    sets.forEach(function (s) {
      if (!seen[s.exercise]) { seen[s.exercise] = []; groups.push({ name: s.exercise, sets: seen[s.exercise] }); }
      seen[s.exercise].push(s);
    });
    var h = '<a href="#/wo" class="dim small" style="text-decoration:none">‹ All workouts</a>' +
      '<div class="card"><div class="row"><div class="grow">' +
      '<div class="wdate" style="font-size:19px">' + fmtDateFull(w.date) + '</div>' +
      '<div class="wmeta">' +
      (w.title ? esc(w.title) + ' · ' : '') +
      (w.body_weight_lb ? w.body_weight_lb + ' lb body weight' : 'no body weight') +
      (w.duration_min ? ' · ' + w.duration_min + ' min' : '') +
      (w.calories ? ' · ' + w.calories + ' cal' : '') +
      (w.steps ? ' · ' + w.steps.toLocaleString() + ' steps' : '') +
      '</div></div></div>' +
      (w.notes ? '<div class="small" style="margin-top:8px">' + esc(w.notes) + '</div>' : '') +
      '<div class="btnrow" style="margin-top:10px"><button class="go ghost sm" id="coachbtn">Ask AI coach</button></div>' +
      '<div id="coachout"></div>' +
      '</div>';
    groups.forEach(function (g) {
      h += '<div class="exname">' + esc(g.name) + '<span class="badge">' + g.sets.length + '</span></div>';
      g.sets.forEach(function (s, i) {
        h += '<div class="setrow"><div class="n">Set ' + (i + 1) + '</div><div class="v">' +
          (s.prefix ? '<span class="tag">' + esc(s.prefix) + '</span>' : '') + setDisplay(s) +
          (s.note ? '<div class="small dim">' + esc(s.note) + '</div>' : '') +
          '</div></div>';
      });
    });
    cardio.forEach(function (c) {
      var t = c.kind;
      if (c.distance_mi) t += ' ' + c.distance_mi + ' mi';
      if (c.duration_min) t += ' · ' + c.duration_min + ' min';
      if (c.steps) t += ' · ' + c.steps.toLocaleString() + ' steps';
      if (c.note) t += ' (' + esc(c.note) + ')';
      h += '<div class="card"><div class="row"><div class="grow"><b>Cardio</b><div class="wmeta">' + t + '</div></div></div></div>';
    });
    if (!groups.length && !cardio.length) h += '<div class="dim">No sets recorded.</div>';
    v.innerHTML = h;
    var cb = document.getElementById('coachbtn');
    if (cb) cb.addEventListener('click', function () {
      askCoach(id, cb, document.getElementById('coachout'));
    });
  }).catch(function (e) { v.innerHTML = '<div class="err">' + esc(e.message) + '</div>'; });
}

var GROUP_OVERRIDES = {
  'Chest Supported Lat Raise': 'push',  // lateral-raise variant, not a lat pull
  'DB Hammer Preacher': 'pull'          // hammer curl on preacher bench
};
function muscleGroup(name) {
  if (GROUP_OVERRIDES[name]) return GROUP_OVERRIDES[name];
  var n = name.toLowerCase();
  if (/(squat|deadlift|\brdl\b|lunge|calf|hip thrust)/.test(n)) return 'legs';
  if (/(bench|press|fly|crossover|\bdips?\b|tricep|skull crusher|lateral raise|trap raise|incline)/.test(n)) return 'push';
  if (/(pull-?up|pulldown|row|curl|face pull|lat prayer|shrug|wrist)/.test(n)) return 'pull';
  return 'other';
}
var GROUP_LABELS = [['push', 'Push'], ['pull', 'Pull'], ['legs', 'Legs'], ['other', 'Other']];

function vExercises(q) {
  var v = $('#view');
  function draw(list) {
    var html = '<input type="search" id="q" placeholder="Search exercises…" value="' + esc(q) + '">';
    GROUP_LABELS.forEach(function (g) {
      var items = list.filter(function (e) { return muscleGroup(e.name) === g[0]; });
      if (!items.length) return;
      html += '<div class="grphead">' + g[1].toUpperCase() + ' <span class="dim">· ' + items.length + '</span></div>' +
        '<div class="exgrid">' + items.map(function (e) {
          return '<a class="exblock" href="#/ex/' + encodeURIComponent(e.name) + '">' +
            '<div class="n">' + esc(e.name) + '</div>' +
            '<div class="m">' + e.workouts + ' workouts · ' + e.sets + ' sets</div></a>';
        }).join('') + '</div>';
    });
    if (!list.length) html += '<div class="dim" style="margin-top:12px">No matches.</div>';
    v.innerHTML = html;
    $('#q').addEventListener('input', function (ev) {
      q = ev.target.value;
      var s = q.toLowerCase();
      draw(cache.exercises.filter(function (e) { return e.name.toLowerCase().indexOf(s) >= 0; }));
      var nq = $('#q'); nq.focus(); nq.setSelectionRange(nq.value.length, nq.value.length);
    });
  }
  if (cache.exercises) { draw(cache.exercises.filter(function (e) { return e.name.toLowerCase().indexOf(q.toLowerCase()) >= 0; })); return; }
  v.innerHTML = '<div class="dim">Loading…</div>';
  api('/api/exercises').then(function (es) { cache.exercises = es; draw(es); })
    .catch(function (e) { v.innerHTML = '<div class="err">' + esc(e.message) + '</div>'; });
}

function topSetText(t) {
  if (!t) return '—';
  if (t.bodyweight) return 'BW' + (t.added_weight_lb ? ' +' + t.added_weight_lb : '') + ' × ' + t.reps;
  var w = t.unit === 'kg' ? t.weight + ' kg' + (t.per_hand ? '/hand' : '') : t.weight + ' lb';
  return w + ' × ' + t.reps + (t.to_failure ? ' F' : '');
}

function vExercise(name) {
  var v = $('#view');
  v.innerHTML = '<div class="dim">Loading…</div>';
  api('/api/exercise?name=' + encodeURIComponent(name)).then(function (d) {
    var prog = d.progression;
    var maxSets = 0;
    prog.forEach(function (p) {
      p.sets.forEach(function (s) { if (s.one_rm != null && s.set_index + 1 > maxSets) maxSets = s.set_index + 1; });
    });
    // Implement filter: DB (kg) vs barbell (lb). Shown only when both exist.
    var impl = 'all', hiddenSets = {}, hasDB = false, hasBB = false;
    prog.forEach(function (p) {
      p.sets.forEach(function (s) {
        if (s.unit === 'kg') hasDB = true;
        if (s.unit === 'lb') hasBB = true;
      });
    });
    function setOK(s) {
      if (impl === 'db') return s.unit === 'kg';
      if (impl === 'bb') return s.unit === 'lb';
      return true;
    }
    var series = [];
    function buildSeries() {
      series = [];
      for (var si = 0; si < maxSets; si++) {
        var pts = [];
        prog.forEach(function (p) {
          var s = p.sets[si];
          if (s && s.one_rm != null && setOK(s)) pts.push({ x: p.date, y: s.one_rm, first: !!p.first_of_day });
        });
        if (pts.length) series.push({
          label: 'Set ' + (si + 1), si: si, color: SET_COLORS[si % SET_COLORS.length],
          hidden: hiddenSets[si] !== undefined ? hiddenSets[si] : si >= 3, points: pts
        });
      }
    }
    buildSeries();
    var h = '<a href="#/" class="dim small" style="text-decoration:none">‹ Exercises</a>' +
      '<div class="card"><div class="wdate" style="font-size:18px">' + esc(d.name) + '</div>' +
      '<div class="wmeta">' + prog.length + ' sessions · est. 1RM via Epley (w × (1 + reps/30))' +
      '<br>Bodyweight moves use that day\u2019s body weight as the load.</div></div>';
    if (series.length) {
      h += '<div class="card"><div class="row" style="margin-bottom:6px"><div class="grow small dim">' +
        'Estimated 1RM over time — tap a set in the legend to show/hide it</div>';
      if (hasDB && hasBB) {
        h += '<div class="seg" id="implseg"><span data-impl="all" class="on">All</span>' +
          '<span data-impl="db">DB</span><span data-impl="bb">Barbell</span></div>';
      }
      h += '</div><div id="exchart"></div></div>';
    }
    h += '<div class="card"><table><tr><th>Date</th><th>Set</th><th>Load × Reps</th><th class="num">Est 1RM</th></tr>' +
      prog.slice().reverse().map(function (p) {
        return p.sets.map(function (s, i) {
          var loadTxt;
          if (s.bodyweight) loadTxt = 'BW' + (s.added_weight_lb ? ' +' + s.added_weight_lb : '') + ' × ' + s.reps;
          else if (s.unit === 'kg') loadTxt = s.weight + ' kg' + (s.per_hand ? '/hand' : '') + ' × ' + s.reps;
          else loadTxt = (s.weight != null ? s.weight + ' lb' : '?') + ' × ' + s.reps;
          if (s.to_failure) loadTxt += ' F';
          return '<tr>' + (i === 0
            ? '<td rowspan="' + p.sets.length + '">' + fmtDate(p.date) +
              (p.first_of_day ? '<br><span class="badge">1st</span>' : '') +
              (p.volume_lb ? '<br><span class="dim small">vol ' + p.volume_lb.toLocaleString() + '</span>' : '') + '</td>'
            : '') +
            '<td>' + (s.set_index + 1) + '</td><td>' + esc(loadTxt) + '</td>' +
            '<td class="num">' + (s.one_rm != null ? Math.round(s.one_rm) : '—') + '</td></tr>';
        }).join('');
      }).join('') + '</table></div>';
    v.innerHTML = h;
    if (series.length) {
      var yFmt = function (y) { return Math.round(y) + ''; };
      var cel = document.getElementById('exchart');
      var paint = function () { buildSeries(); cel.innerHTML = multiChart(series, yFmt); };
      paint();
      cel.addEventListener('click', function (ev) {
        var t = ev.target;
        var lg = t.closest ? t.closest('.lg') : null;
        var mn = t.closest ? t.closest('.mini') : null;
        if (lg && cel.contains(lg)) {
          var si = series[+lg.getAttribute('data-i')].si;
          hiddenSets[si] = !(hiddenSets[si] !== undefined ? hiddenSets[si] : si >= 3);
          paint();
        } else if (mn && cel.contains(mn)) {
          var first3 = mn.getAttribute('data-act') === 'first3';
          for (var k = 0; k < maxSets; k++) hiddenSets[k] = first3 ? k >= 3 : false;
          paint();
        }
      });
      var seg = document.getElementById('implseg');
      if (seg) seg.addEventListener('click', function (ev) {
        var t = ev.target.closest ? ev.target.closest('[data-impl]') : null;
        if (!t || !seg.contains(t)) return;
        impl = t.getAttribute('data-impl');
        seg.querySelectorAll('[data-impl]').forEach(function (el) {
          el.classList.toggle('on', el === t);
        });
        paint();
      });
    }
  }).catch(function (e) { v.innerHTML = '<div class="err">' + esc(e.message) + '</div>'; });
}

function vWeight() {
  var v = $('#view');
  v.innerHTML = '<div class="dim">Loading…</div>';
  api('/api/weights').then(function (ws) {
    var pts = ws.map(function (w) { return { x: w.date, y: w.body_weight_lb }; });
    var h = '<div class="card"><div class="wdate" style="font-size:18px">Body weight</div>' +
      '<div class="wmeta">' + ws.length + ' weigh-ins</div></div>';
    if (pts.length) h += '<div class="card">' + chart(pts, function (y) { return y.toFixed(1); }) + '</div>';
    h += '<div class="card"><table><tr><th>Date</th><th class="num">Weight</th><th>Source</th></tr>' +
      ws.slice().reverse().map(function (w) {
        return '<tr><td>' + fmtDate(w.date) + '</td><td class="num">' + w.body_weight_lb + ' lb</td>' +
          '<td class="dim">' + (w.body_weight_source === 'calprotrack' ? 'CalProTrack' : 'notebook') + '</td></tr>';
      }).join('') + '</table></div>';
    v.innerHTML = h;
  }).catch(function (e) { v.innerHTML = '<div class="err">' + esc(e.message) + '</div>'; });
}

function vNotes() {
  var v = $('#view');
  v.innerHTML = '<div class="dim">Loading…</div>';
  api('/api/notes').then(function (ns) {
    v.innerHTML = ns.length ? ns.map(function (n) {
      return '<div class="card"><div class="wdate">' + (n.date ? fmtDate(n.date) : 'Undated') + '</div>' +
        '<div class="small" style="white-space:pre-wrap; margin-top:6px">' + esc(n.text) + '</div></div>';
    }).join('') : '<div class="dim">No notes.</div>';
  }).catch(function (e) { v.innerHTML = '<div class="err">' + esc(e.message) + '</div>'; });
}

/* ---------- Log-a-workout flow ---------- */

var draft = null;

function downscaleImage(file, cb) {
  var img = new Image();
  img.onload = function () {
    var scale = Math.min(1, 1600 / Math.max(img.width, img.height));
    var c = document.createElement('canvas');
    c.width = Math.round(img.width * scale);
    c.height = Math.round(img.height * scale);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    URL.revokeObjectURL(img.src);
    cb(c.toDataURL('image/jpeg', 0.85));
  };
  img.onerror = function () { cb(null); };
  img.src = URL.createObjectURL(file);
}

function vLog() {
  var v = $('#view');
  draft = null;
  v.innerHTML =
    '<div class="card"><div class="wdate" style="font-size:18px">Log a workout</div>' +
    '<div class="wmeta">Snap your notebook page — I\'ll parse it, then you review and approve.</div></div>' +
    '<div class="card"><div class="btnrow">' +
    '<button class="go" id="btnCam">Take photo</button>' +
    '<button class="go ghost" id="btnUpl">Upload</button></div>' +
    '<input type="file" id="fileCam" accept="image/*" capture="environment" style="display:none">' +
    '<input type="file" id="fileUpl" accept="image/*" style="display:none">' +
    '<div id="logstage" style="margin-top:12px"></div></div>';
  function pick(input) {
    var f = input.files && input.files[0];
    if (!f) return;
    input.value = '';
    $('#logstage').innerHTML = '<div class="dim">Reading photo…</div>';
    downscaleImage(f, function (url) {
      if (!url) { $('#logstage').innerHTML = '<div class="err">Could not read that image.</div>'; return; }
      $('#logstage').innerHTML =
        '<img class="thumb" src="' + url + '">' +
        '<div class="btnrow" style="margin-top:10px"><button class="go" id="btnAnalyze">Analyze this page</button>' +
        '<button class="go ghost" id="btnRetake">Retake</button></div><div id="parseout"></div>';
      $('#btnAnalyze').addEventListener('click', function () { analyzePhoto(url); });
      $('#btnRetake').addEventListener('click', function () { $('#logstage').innerHTML = ''; });
    });
  }
  $('#btnCam').addEventListener('click', function () { $('#fileCam').click(); });
  $('#btnUpl').addEventListener('click', function () { $('#fileUpl').click(); });
  $('#fileCam').addEventListener('change', function (e) { pick(e.target); });
  $('#fileUpl').addEventListener('change', function (e) { pick(e.target); });
}

function analyzePhoto(url) {
  var out = $('#parseout');
  out.innerHTML = '<div class="dim" style="margin-top:10px">Analyzing handwriting… this takes a few seconds.</div>';
  fetch('/api/parse', {
    method: 'POST', credentials: 'same-origin',
    headers: Object.assign(authHeaders(), { 'Content-Type': 'application/json' }),
    body: JSON.stringify({ image: url }),
  }).then(function (r) { return r.json().then(function (d) { return { status: r.status, body: d }; }); })
    .then(function (res) {
      if (res.status !== 200) {
        out.innerHTML = '<div class="err" style="margin-top:10px">' + esc(res.body.message || res.body.error || 'parse failed') + '</div>';
        return;
      }
      draft = res.body;
      if (!draft.warnings) draft.warnings = [];
      ensureExNames(renderReview);
    })
    .catch(function (e) { out.innerHTML = '<div class="err" style="margin-top:10px">' + esc(e.message) + '</div>'; });
}

function ensureExNames(cb) {
  if (cache.exercises) { cb(); return; }
  api('/api/exercises').then(function (es) { cache.exercises = es; cb(); })
    .catch(function () { cache.exercises = []; cb(); });
}

function exNameOptions() {
  return (cache.exercises || []).map(function (e) { return '<option value="' + esc(e.name) + '">'; }).join('');
}

function setRowHtml(ei, si, s) {
  var bw = !!s.bodyweight;
  return '<div class="setedit" data-ex="' + ei + '" data-set="' + si + '">' +
    '<input class="pin" data-field="prefix" value="' + esc(s.prefix || '') + '" placeholder="pre" title="prefix">' +
    '<input class="win" data-field="weight" type="number" step="any" value="' + (s.weight != null ? s.weight : '') + '"' + (bw ? ' disabled' : '') + '>' +
    '<select data-field="unit">' +
    '<option value="lb"' + (s.unit === 'lb' && !bw ? ' selected' : '') + '>lb</option>' +
    '<option value="kg"' + (s.unit === 'kg' && !bw ? ' selected' : '') + '>kg</option>' +
    '<option value="bw"' + (bw ? ' selected' : '') + '>BW</option></select>' +
    '<input class="rin" data-field="reps" type="number" step="any" value="' + (s.reps != null ? s.reps : '') + '" placeholder="reps">' +
    '<label class="flab" title="to failure"><input type="checkbox" data-field="fail"' + (s.to_failure ? ' checked' : '') + '>F</label>' +
    '<button class="xbtn" data-act="delset" title="delete set">✕</button>' +
    (s.note ? '<input class="nin" data-field="note" value="' + esc(s.note) + '" placeholder="set note">' : '') +
    '</div>';
}

function renderReview() {
  var st = $('#logstage');
  var h = '';
  if (draft.warnings && draft.warnings.length) {
    h += '<div class="card warncard"><div class="wdate" style="font-size:14px">Heads up</div><ul class="small">' +
      draft.warnings.map(function (w) { return '<li>' + esc(w) + '</li>'; }).join('') + '</ul></div>';
  }
  h += '<div class="card"><div class="row">' +
    '<div class="grow"><label class="fl">Date</label><input type="date" id="d_date" value="' + esc(draft.date || '') + '"></div>' +
    '<div><label class="fl">Body wt (lb)</label><input type="number" id="d_bw" step="0.1" value="' + (draft.body_weight_lb != null ? draft.body_weight_lb : '') + '"></div>' +
    '</div><label class="fl">Session title (optional)</label><input type="text" id="d_title" value="' + esc(draft.title || '') + '" placeholder="Push / Pull / Legs…"></div>';
  h += '<datalist id="exnames">' + exNameOptions() + '</datalist>';
  h += '<div id="d_exs">';
  draft.exercises.forEach(function (ex, ei) {
    h += '<div class="card"><div class="row"><div class="grow">' +
      '<input type="text" class="exinput" data-ex="' + ei + '" data-field="name" list="exnames" value="' + esc(ex.name) + '">' +
      '</div><button class="xbtn" data-act="delex" data-ex="' + ei + '" title="remove exercise">✕</button></div>' +
      '<div class="small dim" style="margin:6px 0 2px">prefix · weight · unit · reps</div>' +
      ex.sets.map(function (s, si) { return setRowHtml(ei, si, s); }).join('') +
      '<button class="go ghost sm" data-act="addset" data-ex="' + ei + '">+ Set</button></div>';
  });
  h += '</div><button class="go ghost" data-act="addex" style="margin-bottom:10px">+ Add exercise</button>';
  h += '<div class="card"><div class="wdate" style="font-size:15px">Cardio</div><div id="d_cardio">';
  (draft.cardio || []).forEach(function (c, ci) {
    h += '<div class="setedit" data-cardio="' + ci + '">' +
      '<select data-cfield="kind">' +
      ['run', 'walk', 'row', 'other'].map(function (k) {
        return '<option value="' + k + '"' + (c.kind === k ? ' selected' : '') + '>' + k + '</option>';
      }).join('') + '</select>' +
      '<input class="win" data-cfield="distance_mi" type="number" step="any" value="' + (c.distance_mi != null ? c.distance_mi : '') + '" placeholder="mi">' +
      '<input class="win" data-cfield="duration_min" type="number" step="any" value="' + (c.duration_min != null ? c.duration_min : '') + '" placeholder="min">' +
      '<input class="nin" data-cfield="note" value="' + esc(c.note || '') + '" placeholder="note">' +
      '<button class="xbtn" data-act="delcardio" data-cardio="' + ci + '">✕</button></div>';
  });
  h += '</div><button class="go ghost sm" data-act="addcardio">+ Cardio</button></div>';
  h += '<div class="card"><label class="fl">Notes</label><textarea id="d_notes" rows="3">' + esc(draft.notes || '') + '</textarea></div>';
  h += '<div id="d_err"></div><button class="go big" id="d_save">Save workout</button>';
  st.innerHTML = h;

  st.addEventListener('input', onDraftInput);
  st.addEventListener('change', onDraftChange);
  st.addEventListener('click', onDraftClick);
}

function onDraftInput(ev) {
  var t = ev.target, ds = t.dataset;
  if (t.id === 'd_date') { draft.date = t.value; return; }
  if (t.id === 'd_bw') { draft.body_weight_lb = t.value === '' ? null : +t.value; return; }
  if (t.id === 'd_title') { draft.title = t.value; return; }
  if (t.id === 'd_notes') { draft.notes = t.value; return; }
  if (ds.cardio !== undefined && ds.cfield) {
    var c = draft.cardio[+ds.cardio], f = ds.cfield;
    c[f] = (f === 'kind' || f === 'note') ? t.value : (t.value === '' ? null : +t.value);
    return;
  }
  if (ds.ex !== undefined) {
    var ex = draft.exercises[+ds.ex];
    if (ds.field === 'name') { ex.name = t.value; return; }
    if (ds.set !== undefined) {
      var s = ex.sets[+ds.set], fl = ds.field;
      if (fl === 'weight') s.weight = t.value === '' ? null : +t.value;
      else if (fl === 'reps') s.reps = t.value === '' ? null : +t.value;
      else if (fl === 'prefix') s.prefix = t.value;
      else if (fl === 'note') s.note = t.value;
      else if (fl === 'fail') s.to_failure = t.checked;
    }
  }
}

function onDraftChange(ev) {
  var t = ev.target, ds = t.dataset;
  if (ds.ex !== undefined && ds.set !== undefined && ds.field === 'unit') {
    var s = draft.exercises[+ds.ex].sets[+ds.set];
    if (t.value === 'bw') { s.bodyweight = true; s.unit = null; s.weight = null; }
    else { s.bodyweight = false; s.unit = t.value; }
    renderReview();
  }
}

function onDraftClick(ev) {
  var t = ev.target.closest ? ev.target.closest('[data-act]') : null;
  if (!t) {
    if (ev.target.id === 'd_save') saveDraft();
    return;
  }
  var act = t.getAttribute('data-act');
  if (act === 'delset') {
    var se = t.closest('.setedit').dataset;
    draft.exercises[+se.ex].sets.splice(+se.set, 1);
    renderReview();
  } else if (act === 'addset') {
    draft.exercises[+t.getAttribute('data-ex')].sets.push({ weight: null, unit: 'lb', reps: null, to_failure: false, prefix: '', bodyweight: false, added_weight: null, note: '' });
    renderReview();
  } else if (act === 'delex') {
    draft.exercises.splice(+t.getAttribute('data-ex'), 1);
    renderReview();
  } else if (act === 'addex') {
    draft.exercises.push({ name: '', sets: [{ weight: null, unit: 'lb', reps: null, to_failure: false, prefix: '', bodyweight: false, added_weight: null, note: '' }] });
    renderReview();
  } else if (act === 'delcardio') {
    draft.cardio.splice(+t.getAttribute('data-cardio'), 1);
    renderReview();
  } else if (act === 'addcardio') {
    draft.cardio.push({ kind: 'run', distance_mi: null, duration_min: null, note: '' });
    renderReview();
  }
}

function saveDraft() {
  var err = $('#d_err');
  if (!draft.date) { err.innerHTML = '<div class="err">Date is required.</div>'; return; }
  var okEx = draft.exercises.filter(function (e) { return e.name && e.sets.length; });
  if (!okEx.length && !(draft.cardio || []).length) { err.innerHTML = '<div class="err">Add at least one exercise or cardio entry.</div>'; return; }
  err.innerHTML = '';
  var btn = $('#d_save');
  btn.disabled = true; btn.textContent = 'Saving…';
  var payload = {
    date: draft.date, body_weight_lb: draft.body_weight_lb, title: draft.title, notes: draft.notes,
    exercises: okEx.map(function (e) {
      return {
        name: e.name,
        sets: e.sets.map(function (s) {
          return {
            weight: s.bodyweight ? null : s.weight, unit: s.bodyweight ? null : (s.unit || 'lb'),
            reps: s.reps, to_failure: !!s.to_failure, prefix: s.prefix || '',
            bodyweight: !!s.bodyweight, added_weight: s.added_weight != null ? s.added_weight : null,
            note: s.note || '',
          };
        }),
      };
    }),
    cardio: draft.cardio || [],
  };
  fetch('/api/workouts', {
    method: 'POST', credentials: 'same-origin',
    headers: Object.assign(authHeaders(), { 'Content-Type': 'application/json' }),
    body: JSON.stringify(payload),
  }).then(function (r) { return r.json().then(function (d) { return { status: r.status, body: d }; }); })
    .then(function (res) {
      if (res.status !== 200 || !res.body.ok) {
        err.innerHTML = '<div class="err">' + esc(res.body.error || 'save failed') + '</div>';
        btn.disabled = false; btn.textContent = 'Save workout';
        return;
      }
      cache.workouts = null; cache.exercises = null;
      location.hash = '#/w/' + res.body.id;
    })
    .catch(function (e) {
      err.innerHTML = '<div class="err">' + esc(e.message) + '</div>';
      btn.disabled = false; btn.textContent = 'Save workout';
    });
}

/* ---------- AI coach ---------- */

var coachCache = {};

function askCoach(id, btn, out) {
  if (coachCache[id]) { out.innerHTML = coachHtml(coachCache[id]); return; }
  btn.disabled = true; btn.textContent = 'Thinking…';
  fetch('/api/coach', {
    method: 'POST', credentials: 'same-origin',
    headers: Object.assign(authHeaders(), { 'Content-Type': 'application/json' }),
    body: JSON.stringify({ workout_id: id }),
  }).then(function (r) { return r.json().then(function (d) { return { status: r.status, body: d }; }); })
    .then(function (res) {
      btn.disabled = false; btn.textContent = 'Ask AI coach';
      if (res.status !== 200 || !res.body.evaluation) {
        out.innerHTML = '<div class="err">' + esc(res.body.message || res.body.error || 'coach failed') + '</div>';
        return;
      }
      coachCache[id] = res.body.evaluation;
      out.innerHTML = coachHtml(res.body.evaluation);
    })
    .catch(function (e) {
      btn.disabled = false; btn.textContent = 'Ask AI coach';
      out.innerHTML = '<div class="err">' + esc(e.message) + '</div>';
    });
}

function coachHtml(text) {
  return '<div class="card coachcard"><div class="wdate" style="font-size:15px">Coach\'s take</div>' +
    '<div class="small" style="white-space:pre-wrap; margin-top:6px">' + esc(text) + '</div></div>';
}

window.addEventListener('hashchange', function () { nav(); });
nav();
