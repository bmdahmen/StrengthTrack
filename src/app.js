/* Workout Log frontend */
'use strict';

function $(sel) { return document.querySelector(sel); }

function api(path, opts) {
  return fetch(path, Object.assign({ credentials: 'same-origin' }, opts || {}))
    .then(function (r) {
      if (r.status === 401) { location.reload(); throw new Error('unauthorized'); }
      if (!r.ok) throw new Error('request failed: ' + r.status);
      return r.json();
    });
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
  // series: [{label, color, points:[{x:'2026-10-03', y:1.2, first:true}]}]
  var W = 360, H = 230, L = 42, R = 10, T = 14, B = 30;
  var iw = W - L - R, ih = H - T - B;
  var dates = [], seen = {};
  series.forEach(function (s) {
    s.points.forEach(function (p) {
      if (!seen[p.x]) { seen[p.x] = 1; dates.push(p.x); }
    });
  });
  dates.sort();
  var allY = [];
  series.forEach(function (s) { s.points.forEach(function (p) { allY.push(p.y); }); });
  if (!allY.length) return '<div class="dim">No data.</div>';
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
  series.forEach(function (s) {
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
  var legend = series.map(function (s) {
    return '<span style="margin-right:12px; font-size:12px; color:#9aa4b2">' +
      '<span style="display:inline-block; width:10px; height:10px; border-radius:50%; background:' + s.color + '; margin-right:5px"></span>' +
      esc(s.label) + '</span>';
  }).join('');
  return '<div style="margin-bottom:8px">' + legend +
    '<span style="font-size:12px; color:#9aa4b2">○ = first exercise of the day</span></div>' +
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
  document.querySelectorAll('[data-nav]').forEach(function (a) {
    var href = a.getAttribute('href');
    a.classList.toggle('on', href === '#/' ? (h === '#/' || h.indexOf('#/w/') === 0) : h.indexOf(href) === 0);
  });
  if (h === '#/' || h === '') return vWorkouts();
  var m = h.match(/^#\/w\/(\d+)$/);
  if (m) return vWorkout(m[1]);
  if (h === '#/ex') return vExercises('');
  m = h.match(/^#\/ex\/(.+)$/);
  if (m) return vExercise(decodeURIComponent(m[1]));
  if (h === '#/wt') return vWeight();
  if (h === '#/notes') return vNotes();
  return vWorkouts();
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
    var h = '<a href="#/" class="dim small" style="text-decoration:none">‹ All workouts</a>' +
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
  }).catch(function (e) { v.innerHTML = '<div class="err">' + esc(e.message) + '</div>'; });
}

function vExercises(q) {
  var v = $('#view');
  function draw(list) {
    v.innerHTML = '<input type="search" id="q" placeholder="Search exercises…" value="' + esc(q) + '">' +
      '<div id="list">' + list.map(function (e) {
        return '<a class="wo" href="#/ex/' + encodeURIComponent(e.name) + '"><div class="card"><div class="row">' +
          '<div class="grow"><div class="wdate" style="font-size:15px">' + esc(e.name) + '</div>' +
          '<div class="wmeta">' + e.workouts + ' workouts · ' + e.sets + ' sets</div></div>' +
          '<div class="dim">›</div></div></div></a>';
      }).join('') + '</div>';
    $('#q').addEventListener('input', function (ev) {
      var s = ev.target.value.toLowerCase();
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
    var series = [];
    for (var si = 0; si < maxSets; si++) {
      var pts = [];
      prog.forEach(function (p) {
        var s = p.sets[si];
        if (s && s.one_rm != null) pts.push({ x: p.date, y: s.one_rm, first: !!p.first_of_day });
      });
      if (pts.length) series.push({ label: 'Set ' + (si + 1), color: SET_COLORS[si % SET_COLORS.length], points: pts });
    }
    var h = '<a href="#/ex" class="dim small" style="text-decoration:none">‹ Exercises</a>' +
      '<div class="card"><div class="wdate" style="font-size:18px">' + esc(d.name) + '</div>' +
      '<div class="wmeta">' + prog.length + ' sessions · est. 1RM via Epley (w × (1 + reps/30))' +
      '<br>Bodyweight moves use that day\u2019s body weight as the load.</div></div>';
    if (series.length) {
      h += '<div class="card"><div class="small dim" style="margin-bottom:6px">Estimated 1RM over time — one line per set number</div>' +
        multiChart(series, function (y) { return Math.round(y) + ''; }) + '</div>';
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

window.addEventListener('hashchange', function () { nav(); });
nav();
