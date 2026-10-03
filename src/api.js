// StrengthTrack — Cloudflare Worker + D1. Single-file app.
// Serves the frontend and a small JSON API. Open access (no login).

function json(data, status) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}

async function handleApi(request, env, url) {
  const path = url.pathname;

  if (path === '/api/workouts') {
    const rows = await env.DB.prepare(
      'SELECT w.id, w.date, w.title, w.body_weight_lb, w.body_weight_source, w.duration_min, w.calories, w.steps,' +
      ' (SELECT COUNT(*) FROM sets s WHERE s.workout_id = w.id) AS set_count,' +
      ' (SELECT COUNT(DISTINCT s.exercise) FROM sets s WHERE s.workout_id = w.id) AS exercise_count' +
      ' FROM workouts w ORDER BY w.date DESC, w.id DESC'
    ).all();
    return json(rows.results);
  }

  let m = path.match(/^\/api\/workout\/(\d+)$/);
  if (m) {
    const id = Number(m[1]);
    const w = await env.DB.prepare('SELECT * FROM workouts WHERE id = ?').bind(id).first();
    if (!w) return json({ error: 'not found' }, 404);
    const sets = await env.DB.prepare(
      'SELECT * FROM sets WHERE workout_id = ? ORDER BY set_index'
    ).bind(id).all();
    const cardio = await env.DB.prepare(
      'SELECT * FROM cardio WHERE workout_id = ?'
    ).bind(id).all();
    return json({ workout: w, sets: sets.results, cardio: cardio.results });
  }

  if (path === '/api/exercises') {
    const rows = await env.DB.prepare(
      'SELECT exercise AS name, COUNT(DISTINCT workout_id) AS workouts, COUNT(*) AS sets' +
      ' FROM sets GROUP BY exercise ORDER BY workouts DESC, name'
    ).all();
    return json(rows.results);
  }

  if (path === '/api/exercise') {
    const name = url.searchParams.get('name');
    if (!name) return json({ error: 'missing name' }, 400);
    const rows = await env.DB.prepare(
      'SELECT w.date, w.body_weight_lb, s.set_index, s.exercise_index, s.reps, s.weight, s.unit, s.per_hand, s.total_lb,' +
      ' s.bodyweight, s.added_weight_lb, s.to_failure, s.prefix' +
      ' FROM sets s JOIN workouts w ON w.id = s.workout_id' +
      ' WHERE s.exercise = ? ORDER BY w.date, s.set_index'
    ).bind(name).all();
    const byDate = {};
    for (const r of rows.results) {
      const d = r.date;
      if (!byDate[d]) byDate[d] = { date: d, sets: [] };
      // Effective load in lb for 1RM estimation (Epley).
      // Bodyweight moves use that day's body weight (+ added weight).
      let load = null;
      if (r.bodyweight) {
        if (r.body_weight_lb != null) load = r.body_weight_lb + (r.added_weight_lb || 0);
      } else {
        load = r.total_lb;
      }
      let one_rm = null;
      if (load != null && r.reps != null && r.reps > 0) {
        one_rm = r.reps === 1 ? load : load * (1 + r.reps / 30);
        one_rm = Math.round(one_rm * 10) / 10;
      }
      const s = {
        set_index: r.set_index, exercise_index: r.exercise_index, reps: r.reps,
        weight: r.weight, unit: r.unit,
        per_hand: r.per_hand, total_lb: r.total_lb, bodyweight: r.bodyweight,
        added_weight_lb: r.added_weight_lb, to_failure: r.to_failure, prefix: r.prefix,
        load_lb: load != null ? Math.round(load * 10) / 10 : null,
        one_rm: one_rm,
      };
      byDate[d].sets.push(s);
      if (r.exercise_index === 0) byDate[d].first_of_day = true;
    }
    const prog = Object.values(byDate).map(function (g) {
      let top = null, vol = 0;
      for (const s of g.sets) {
        if (s.total_lb != null && s.reps != null) {
          vol += s.total_lb * s.reps;
          if (!top || s.total_lb > top.total_lb) top = s;
        }
      }
      return { date: g.date, sets: g.sets, first_of_day: !!g.first_of_day, top: top, volume_lb: Math.round(vol) };
    });
    return json({ name: name, progression: prog, one_rm_formula: 'epley' });
  }

  if (path === '/api/weights') {
    const rows = await env.DB.prepare(
      'SELECT date, body_weight_lb, body_weight_source FROM workouts' +
      ' WHERE body_weight_lb IS NOT NULL ORDER BY date'
    ).all();
    return json(rows.results);
  }

  if (path === '/api/notes') {
    const rows = await env.DB.prepare('SELECT * FROM notes ORDER BY date').all();
    return json(rows.results);
  }

  if (path === '/api/backfill-weights' && request.method === 'POST') {
    const missing = await env.DB.prepare(
      "SELECT id, date FROM workouts WHERE body_weight_lb IS NULL ORDER BY date"
    ).all();
    let filled = 0;
    const details = [];
    for (const w of missing.results) {
      const mr = await env.CAL.prepare(
        'SELECT weightAM, weightPM FROM measurements WHERE date = ? AND user_id = ?'
      ).bind(w.date, 'fbbf38d9c49a4819').first();
      const wt = mr && (mr.weightAM || mr.weightPM);
      if (wt) {
        await env.DB.prepare(
          "UPDATE workouts SET body_weight_lb = ?, body_weight_source = 'calprotrack' WHERE id = ?"
        ).bind(wt, w.id).run();
        filled++;
        details.push({ date: w.date, weight: wt });
      } else {
        details.push({ date: w.date, weight: null });
      }
    }
    return json({ filled: filled, details: details });
  }

  return json({ error: 'not found' }, 404);
}
