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

const CLAUDE_MODEL_DEFAULT = 'claude-sonnet-5'; // Anthropic API

function ptDate() {
  // YYYY-MM-DD in America/Los_Angeles
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  return p;
}

function extractJson(text) {
  const a = text.indexOf('{'), b = text.lastIndexOf('}');
  if (a < 0 || b <= a) throw new Error('no JSON in model response');
  return JSON.parse(text.slice(a, b + 1));
}

async function callClaude(env, model, maxTokens, messages) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({ model: model, max_tokens: maxTokens, messages: messages }),
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error.message || data.error.type || 'model error');
  return (data.content || []).filter(function (b) { return b.type === 'text'; }).map(function (b) { return b.text; }).join('\n');
}

function claudeModel(env) { return env.CLAUDE_MODEL || CLAUDE_MODEL_DEFAULT; }

function parsePrompt(exNames, today) {
  return 'You transcribe a photo of a handwritten workout notebook page into JSON. ' +
  'Today is ' + today + '. Dates like "10/3" are in the current year unless clearly otherwise.\n' +
  'RULES:\n' +
  '- Page header looks like "10/3-151.8": date, then bodyweight in lb (always 140-170 range). Record body_weight_lb. No weight written -> null, do not guess.\n' +
  '- Sets are WEIGHTxREPS, e.g. "150x11". Trailing F ("65x6F") -> to_failure true. Ignore his arithmetic like "=216".\n' +
  '- Prefix before the weight ("WG", "NG", "CG", "CC") -> keep verbatim in "prefix".\n' +
  '- "BW" = bodyweight: bodyweight true, weight null. "BWx11" -> reps 11. "Weighted Pullup 25x11" -> bodyweight true, added_weight 25.\n' +
  '- Dropset arrows "22.5x8 -> BWx17" -> TWO sets: {weight 22.5, reps 8} then {bodyweight true, reps 17, note "dropset to bodyweight"}.\n' +
  '- Dumbbell exercises (name has DB/Dumbbell, or single-DB moves like Goblet Squat): weight is KILOGRAMS, unit "kg". Everything else is pounds, unit "lb". Bodyweight sets: unit null.\n' +
  '- Cardio: "5k 25:32" -> {"kind":"run","distance_mi":3.11,"duration_min":25.5}. "5k Row 25:59" -> kind "row". "20 min walk" -> kind "walk", duration_min 20. Bare times on a lifting page go in notes, not cardio.\n' +
  '- Exercise names: use the closest name from this canonical list when it is clearly the same exercise:\n' +
  exNames.join(', ') + '\n' +
  '- If nothing on the list fits, use the name as written (it will be reviewed).\n' +
  '- Truly illegible: put "ILLEGIBLE: <best guess>" in the set note. Never invent numbers.\n' +
  '- Title: only if the page labels the session (Push/Pull/Legs). Else "".\n' +
  'Respond with ONLY this JSON object, no other text:\n' +
  '{"date":"YYYY-MM-DD","body_weight_lb":151.8,"title":"","notes":"","warnings":["anything uncertain, as short strings"],' +
  '"exercises":[{"name":"<canonical or as-written>","sets":[{"weight":150,"unit":"lb","reps":11,"to_failure":false,"prefix":"","bodyweight":false,"added_weight":null,"note":""}]}],' +
  '"cardio":[{"kind":"run","distance_mi":3.11,"duration_min":25.5,"note":""}]}';
}

async function handleParse(request, env, user) {
  if (!env.ANTHROPIC_API_KEY) {
    return json({ error: 'vision_not_configured', message: 'Photo parsing needs an ANTHROPIC_API_KEY secret on the worker.' }, 503);
  }
  const limited = await checkLimit(env, user, 'parse');
  if (limited) return limited;
  let body = {};
  try { body = await request.json(); } catch (e) { return json({ error: 'bad request' }, 400); }
  const m = String(body.image || '').match(/^data:(image\/[a-zA-Z0-9+.-]+);base64,([A-Za-z0-9+/=]+)$/);
  if (!m) return json({ error: 'missing or invalid image (expected data URL)' }, 400);
  const exRows = await env.DB.prepare(
    'SELECT DISTINCT s.exercise FROM sets s JOIN workouts w ON w.id = s.workout_id WHERE w.user_id = ? ORDER BY s.exercise'
  ).bind(user.id).all();
  const exNames = exRows.results.map(function (r) { return r.exercise; });
  const today = ptDate();
  let text;
  try {
    text = await callClaude(env, claudeModel(env), 4000, [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: m[1], data: m[2] } },
        { type: 'text', text: parsePrompt(exNames, today) },
      ],
    }]);
  } catch (e) {
    return json({ error: 'vision_failed', message: e.message }, 502);
  }
  let parsed;
  try { parsed = extractJson(text); }
  catch (e) { return json({ error: 'bad_parse', message: 'Could not read the model response as JSON.' }, 502); }
  // light normalization
  parsed.date = parsed.date || today;
  if (!Array.isArray(parsed.exercises)) parsed.exercises = [];
  if (!Array.isArray(parsed.cardio)) parsed.cardio = [];
  if (!Array.isArray(parsed.warnings)) parsed.warnings = [];
  return json(parsed);
}

function setTotalLb(name, s) {
  // mirrors tools/seed.py set_total_lb
  if (s.bodyweight) return s.added_weight != null ? s.added_weight : null;
  if (s.weight == null || s.unit == null) return null;
  if (s.unit === 'kg') {
    const lb = s.weight * 2.20462;
    const perHand = /goblet/i.test(name) ? 0 : (/\bdb\b|dumbbell/i.test(name) ? 1 : 0);
    return Math.round(lb * (perHand ? 2 : 1) * 10) / 10;
  }
  return Math.round(s.weight * 10) / 10;
}

async function handleSaveWorkout(request, env, user) {
  let b = {};
  try { b = await request.json(); } catch (e) { return json({ error: 'bad request' }, 400); }
  if (!b.date || !/^\d{4}-\d{2}-\d{2}$/.test(b.date)) return json({ error: 'date is required (YYYY-MM-DD)' }, 400);
  const exercises = (b.exercises || []).filter(function (e) { return e.name && (e.sets || []).length; });
  const cardio = b.cardio || [];
  if (!exercises.length && !cardio.length) return json({ error: 'nothing to save' }, 400);
  const wid = (await env.DB.prepare('SELECT COALESCE(MAX(id),0)+1 AS n FROM workouts').first()).n;
  await env.DB.prepare(
    'INSERT INTO workouts (id, date, title, body_weight_lb, body_weight_source, notes, user_id) VALUES (?,?,?,?,?,?,?)'
  ).bind(wid, b.date, b.title || '', b.body_weight_lb != null ? b.body_weight_lb : null, 'notebook', b.notes || '', user.id).run();
  let sid = (await env.DB.prepare('SELECT COALESCE(MAX(id),0) AS n FROM sets').first()).n;
  for (let ei = 0; ei < exercises.length; ei++) {
    const ex = exercises[ei];
    const sets = ex.sets || [];
    for (let i = 0; i < sets.length; i++) {
      const s = sets[i];
      sid++;
      const perHand = s.unit === 'kg' ? (/goblet/i.test(ex.name) ? 0 : (/\bdb\b|dumbbell/i.test(ex.name) ? 1 : 0)) : 0;
      await env.DB.prepare(
        'INSERT INTO sets (id, workout_id, exercise, exercise_raw, set_index, exercise_index, reps, weight, unit,' +
        ' per_hand, total_lb, bodyweight, added_weight_lb, warmup, to_failure, prefix, note)' +
        ' VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)'
      ).bind(sid, wid, ex.name, ex.name, i, ei,
        s.reps != null ? s.reps : null, s.weight != null ? s.weight : null, s.unit || null,
        perHand, setTotalLb(ex.name, s), s.bodyweight ? 1 : 0,
        s.added_weight != null ? s.added_weight : null, 0, s.to_failure ? 1 : 0,
        s.prefix || '', s.note || '').run();
    }
  }
  let cid = (await env.DB.prepare('SELECT COALESCE(MAX(id),0) AS n FROM cardio').first()).n;
  for (const c of cardio) {
    cid++;
    await env.DB.prepare(
      'INSERT INTO cardio (id, workout_id, kind, distance_mi, duration_min, steps, note) VALUES (?,?,?,?,?,?,?)'
    ).bind(cid, wid, c.kind || '', c.distance_mi != null ? c.distance_mi : null,
      c.duration_min != null ? c.duration_min : null, null, c.note || '').run();
  }
  return json({ ok: true, id: wid });
}

const COACH_PROFILE =
  'The athlete is Brian, in his first 6 months of consistent weight training (newbie gains phase), ' +
  'training Push/Pull/Legs. He is currently lean-bulking at roughly +200 kcal/day surplus ' +
  '(3100 kcal training days, 2700 rest days). Dumbbell weights in his logs are kg per dumbbell; ' +
  'everything else is pounds. He coaches wrestling, rows regularly, had arthroscopic knee surgery ' +
  '15+ years ago and trains around joint concerns (prefers rowing over running).';

async function handleCoach(request, env, user) {
  if (!env.ANTHROPIC_API_KEY) {
    return json({ error: 'coach_not_configured', message: 'Coaching needs an ANTHROPIC_API_KEY secret on the worker.' }, 503);
  }
  const limited = await checkLimit(env, user, 'coach');
  if (limited) return limited;
  let b = {};
  try { b = await request.json(); } catch (e) { return json({ error: 'bad request' }, 400); }
  const id = Number(b.workout_id);
  if (!id) return json({ error: 'workout_id required' }, 400);
  const w = await env.DB.prepare('SELECT * FROM workouts WHERE id = ? AND user_id = ?').bind(id, user.id).first();
  if (!w) return json({ error: 'not found' }, 404);
  const sets = await env.DB.prepare(
    'SELECT exercise, set_index, reps, weight, unit, per_hand, total_lb, bodyweight, added_weight_lb, to_failure' +
    ' FROM sets WHERE workout_id = ? ORDER BY exercise_index, set_index'
  ).bind(id).all();
  const exNames = [...new Set(sets.results.map(function (s) { return s.exercise; }))];
  // recent best-1RM trend per exercise (last 4 sessions)
  const trends = [];
  for (const name of exNames) {
    const rows = await env.DB.prepare(
      'SELECT w.date, s.reps, s.total_lb, s.bodyweight, s.added_weight_lb, w.body_weight_lb' +
      ' FROM sets s JOIN workouts w ON w.id = s.workout_id' +
      ' WHERE s.exercise = ? AND w.user_id = ? AND w.date <= ? ORDER BY w.date DESC LIMIT 40'
    ).bind(name, user.id, w.date).all();
    const byDate = {};
    for (const r of rows.results) {
      let load = r.bodyweight ? (r.body_weight_lb != null ? r.body_weight_lb + (r.added_weight_lb || 0) : null) : r.total_lb;
      if (load == null || r.reps == null || r.reps <= 0) continue;
      const est = r.reps === 1 ? load : load * (1 + r.reps / 30);
      if (!byDate[r.date] || est > byDate[r.date]) byDate[r.date] = Math.round(est);
    }
    const ds = Object.keys(byDate).sort().slice(-4);
    if (ds.length >= 2) trends.push(name + ': ' + ds.map(function (d) { return d.slice(5) + ' ' + byDate[d]; }).join(' -> '));
  }
  // last 7 workouts for frequency/split context
  const recent = await env.DB.prepare(
    'SELECT w.date, GROUP_CONCAT(DISTINCT s.exercise) AS exs FROM workouts w' +
    ' LEFT JOIN sets s ON s.workout_id = w.id WHERE w.user_id = ? AND w.date <= ? GROUP BY w.id ORDER BY w.date DESC LIMIT 7'
  ).bind(user.id, w.date).all();
  const recentTxt = recent.results.reverse().map(function (r) { return r.date + ' [' + (r.exs || 'cardio') + ']'; }).join('\n');
  const wts = await env.DB.prepare(
    'SELECT date, body_weight_lb FROM workouts WHERE body_weight_lb IS NOT NULL AND user_id = ? AND date <= ? ORDER BY date DESC LIMIT 5'
  ).bind(user.id, w.date).all();
  const wtTxt = wts.results.reverse().map(function (r) { return r.date + ' ' + r.body_weight_lb + ' lb'; }).join(', ');

  const setLines = sets.results.map(function (s) {
    let t = s.exercise + ' set ' + (s.set_index + 1) + ': ';
    t += s.bodyweight ? ('BW' + (s.added_weight_lb ? '+' + s.added_weight_lb : '') + 'x' + s.reps)
      : ((s.weight != null ? s.weight + (s.unit || '') : '?') + 'x' + s.reps);
    if (s.to_failure) t += 'F';
    return t;
  }).join('\n');

  const prompt =
    'You are a direct, knowledgeable strength coach reviewing one workout. ' + COACH_PROFILE + '\n\n' +
    'WORKOUT ' + w.date + (w.title ? ' (' + w.title + ')' : '') + ', bodyweight ' + (w.body_weight_lb || '?') + ' lb:\n' + setLines + '\n\n' +
    'Recent estimated-1RM trend per exercise (last sessions, lb):\n' + (trends.join('\n') || 'n/a') + '\n\n' +
    'Last 7 sessions:\n' + recentTxt + '\n\nRecent bodyweights: ' + wtTxt + '\n\n' +
    'Evaluate this workout in under 220 words. Be specific and use his numbers. ' +
    'Cover: (1) what went well, (2) anything that looks off (stalls, regressions, volume gaps, form-risk patterns like grinding singles), ' +
    '(3) one or two concrete suggestions for next time. No generic fitness advice, no disclaimers, no medical diagnoses. ' +
    'Plain text, short paragraphs, no markdown headers.';
  let evaluation;
  try {
    evaluation = await callClaude(env, claudeModel(env), 600, [
      { role: 'user', content: [{ type: 'text', text: prompt }] },
    ]);
  } catch (e) {
    return json({ error: 'coach_failed', message: e.message }, 502);
  }
  return json({ workout_id: id, evaluation: evaluation.trim() });
}

async function ensureSuggestSchema(env) {
  // Self-heal: add the suggest columns if this worker predates them.
  const ucols = await env.DB.prepare('PRAGMA table_info(users)').all().catch(function () { return { results: [] }; });
  if (!(ucols.results || []).some(function (c) { return c.name === 'lim_suggest'; })) {
    try { await env.DB.prepare('ALTER TABLE users ADD COLUMN lim_suggest INTEGER').run(); } catch (e) { /* exists */ }
  }
  const rcols = await env.DB.prepare('PRAGMA table_info(rate_limits)').all().catch(function () { return { results: [] }; });
  if (!(rcols.results || []).some(function (c) { return c.name === 'suggest_count'; })) {
    try { await env.DB.prepare('ALTER TABLE rate_limits ADD COLUMN suggest_count INTEGER DEFAULT 0').run(); } catch (e) { /* exists */ }
  }
}

function parseSuggestJson(raw) {
  const tries = [raw.trim()];
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) tries.push(fence[1].trim());
  const greedy = raw.match(/\{[\s\S]*\}/);
  if (greedy) tries.push(greedy[0]);
  for (const t of tries) {
    try {
      const o = JSON.parse(t);
      if (o && o.target && o.reason) return { target: String(o.target), reason: String(o.reason) };
    } catch (e) { /* try next */ }
  }
  // Last resort: tolerate broken quoting inside the reason and extract fields directly.
  const tm = raw.match(/"target"\s*:\s*"((?:[^"\\]|\\.)*)"/);
  const rm = raw.match(/"reason"\s*:\s*"((?:[^"\\]|\\.)*)"/);
  if (tm && rm) return { target: tm[1], reason: rm[1] };
  return null;
}

async function handleSuggest(request, env, user) {
  if (!env.ANTHROPIC_API_KEY) {
    return json({ error: 'ai_not_configured', message: 'AI suggestions need an ANTHROPIC_API_KEY secret on the worker.' }, 503);
  }
  await ensureSuggestSchema(env);
  const limited = await checkLimit(env, user, 'suggest');
  if (limited) return limited;
  let b = {};
  try { b = await request.json(); } catch (e) { return json({ error: 'bad request' }, 400); }
  const name = (b.exercise || '').trim();
  if (!name) return json({ error: 'exercise required' }, 400);
  // Last 8 sessions: top set per date by Epley e1RM + any session notes (pain flags).
  const rows = await env.DB.prepare(
    'SELECT w.date, w.body_weight_lb, s.reps, s.weight, s.unit, s.per_hand, s.total_lb,' +
    ' s.bodyweight, s.added_weight_lb, s.set_index FROM sets s' +
    ' JOIN workouts w ON w.id = s.workout_id' +
    ' WHERE s.exercise = ? AND w.user_id = ? ORDER BY w.date DESC, s.set_index ASC LIMIT 240'
  ).bind(name, user.id).all();
  const noteRows = await env.DB.prepare(
    'SELECT w.date, n.text FROM notes n JOIN workouts w ON w.id = n.workout_id' +
    ' WHERE n.exercise = ? AND w.user_id = ? ORDER BY w.date DESC LIMIT 8'
  ).bind(name, user.id).all().catch(function () { return { results: [] }; });
  const notesByDate = {};
  (noteRows.results || []).forEach(function (r) {
    (notesByDate[r.date] = notesByDate[r.date] || []).push(r.text);
  });
  const byDate = {};
  (rows.results || []).forEach(function (r) {
    let load = r.bodyweight ? (r.body_weight_lb != null ? r.body_weight_lb + (r.added_weight_lb || 0) : null) : r.total_lb;
    if (load == null || r.reps == null || r.reps <= 0) return;
    const est = r.reps === 1 ? load : load * (1 + r.reps / 30);
    const lbl = r.bodyweight
      ? ('BW' + (r.added_weight_lb ? '+' + r.added_weight_lb : '') + ' x ' + r.reps)
      : ((r.weight != null ? (r.per_hand ? r.weight + 'kg/hand' : r.weight + 'lb') : '?') + ' x ' + r.reps);
    const d = byDate[r.date] || (byDate[r.date] = { best: null, notes: notesByDate[r.date] || [] });
    if (!d.best || est > d.best.est) d.best = { est: est, label: lbl };
  });
  const dates = Object.keys(byDate).sort().slice(-8);
  if (!dates.length) return json({ error: 'no data for ' + name }, 404);
  const lines = dates.map(function (d) {
    let t = d.slice(5) + ': top set ' + byDate[d].best.label + ' (est 1RM ' + Math.round(byDate[d].best.est) + ' lb)';
    if (byDate[d].notes.length) t += ' — notes: ' + byDate[d].notes.join(' / ').slice(0, 200);
    return t;
  });
  // Math baseline: trailing 5-session e1RM trend + 2%.
  const tops = dates.slice(-5).map(function (d) { return byDate[d].best.est; });
  const base = tops[tops.length - 1];
  const mathTarget = base * 1.02;
  const prompt =
    'You are a strength coach picking next session\u2019s top-set target for one exercise. ' + COACH_PROFILE + '\n\n' +
    'Exercise: ' + name + '\n' +
    'Recent sessions (top set each, newest last):\n' + lines.join('\n') + '\n\n' +
    'Math baseline: trailing 5-session estimated-1RM trend ends at ' + Math.round(base) +
    ', so +2% is ' + Math.round(mathTarget) + ' lb. ' +
    'The lifter usually targets small concrete jumps: same weight +1 rep, or +5 lb (barbell) / +2.5 kg per dumbbell.\n\n' +
    'Reply with ONLY a JSON object, no code fences, no commentary, no other text: {"target": "<weight> x <reps>", "reason": "<=25 words>"}. ' +
    'Target must be a concrete jump at or near the math baseline. If the notes mention pain, a recent stall, or a big gap since last session, ' +
    'override downward (repeat or reduce) and say why in the reason. Keep units as shown above.';
  let raw;
  try {
    raw = await callClaude(env, claudeModel(env), 150, [
      { role: 'user', content: [{ type: 'text', text: prompt }] },
    ]);
  } catch (e) {
    return json({ error: 'suggest_failed', message: e.message }, 502);
  }
  let out = parseSuggestJson(raw);
  if (!out) {
    return json({ error: 'suggest_parse_failed', message: 'AI response was not valid JSON: ' + raw.slice(0, 300) }, 502);
  }
  return json({ exercise: name, target: String(out.target).slice(0, 60), reason: String(out.reason).slice(0, 200), math_target_1rm: Math.round(mathTarget) });
}

/* ---------- Google sign-in + per-user data + rate limits (mirrors CalProTrack) ---------- */

function googleClientId(env) {
  return env.GOOGLE_CLIENT_ID || '156334413688-usb68f1fldmrhic94mn925l75hnk82pk.apps.googleusercontent.com';
}
const OWNER_EMAIL = 'bmdahmen@gmail.com';
const LIMITS_DEFAULT = { parse: 20, coach: 25, suggest: 15 };
const LIMITS_OWNER = 9999;

let authSchemaReady = false;
async function ensureAuthSchema(env) {
  if (authSchemaReady) return;
  await env.DB.prepare(
    'CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, google_id TEXT UNIQUE, name TEXT, email TEXT,' +
    ' avatar TEXT, created_at TEXT, lim_parse INTEGER, lim_coach INTEGER, lim_suggest INTEGER)'
  ).run();
  // Legacy password-login sessions table (token, created_at) predates Google auth
  // and lacks token_sha/user_id/expires_at — replace it; its rows are useless now.
  const sessCols = await env.DB.prepare('PRAGMA table_info(sessions)').all().catch(function () { return { results: [] }; });
  const hasTokenSha = (sessCols.results || []).some(function (c) { return c.name === 'token_sha'; });
  if (!hasTokenSha) {
    await env.DB.prepare('DROP TABLE IF EXISTS sessions').run();
  }
  await env.DB.prepare(
    'CREATE TABLE IF NOT EXISTS sessions (token_sha TEXT PRIMARY KEY, user_id TEXT, created_at TEXT, expires_at TEXT)'
  ).run();
  await env.DB.prepare(
    'CREATE TABLE IF NOT EXISTS rate_limits (user_id TEXT, date TEXT, parse_count INTEGER DEFAULT 0,' +
    ' coach_count INTEGER DEFAULT 0, suggest_count INTEGER DEFAULT 0, PRIMARY KEY (user_id, date))'
  ).run();
  try { await env.DB.prepare('ALTER TABLE workouts ADD COLUMN user_id TEXT').run(); } catch (e) { /* exists */ }
  try { await env.DB.prepare('ALTER TABLE notes ADD COLUMN user_id TEXT').run(); } catch (e) { /* exists */ }
  authSchemaReady = true;
}

async function sha256Hex(str) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return [...new Uint8Array(buf)].map(function (b) { return b.toString(16).padStart(2, '0'); }).join('');
}

function randHex(n) {
  const a = new Uint8Array(n);
  crypto.getRandomValues(a);
  return [...a].map(function (b) { return b.toString(16).padStart(2, '0'); }).join('');
}

async function resolveUser(request, env) {
  let token = null;
  const h = request.headers.get('Authorization') || '';
  const m = h.match(/^Bearer\s+(.+)$/i);
  if (m) token = m[1].trim();
  if (!token && request.method === 'POST') {
    try {
      const b = await request.clone().json();
      if (b && b.session_token) token = b.session_token;
    } catch (e) { /* ignore */ }
  }
  if (!token) return null;
  const sha = await sha256Hex(token);
  const s = await env.DB.prepare(
    'SELECT s.user_id, u.* FROM sessions s JOIN users u ON u.id = s.user_id' +
    ' WHERE s.token_sha = ? AND s.expires_at > datetime(\'now\')'
  ).bind(sha).first();
  return s || null;
}

async function handleGoogleAuth(request, env) {
  await ensureAuthSchema(env);
  let body = {};
  try { body = await request.json(); } catch (e) { return json({ error: 'bad request' }, 400); }
  if (!body.token) return json({ error: 'missing token' }, 400);
  const verify = await fetch('https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(body.token));
  const info = await verify.json();
  if (!verify.ok || !info || info.aud !== googleClientId(env) || !info.sub) {
    return json({ error: 'Google verification failed', code: 'AUTH_FAILED' }, 401);
  }
  const now = new Date().toISOString();
  let user = await env.DB.prepare('SELECT * FROM users WHERE google_id = ?').bind(info.sub).first();
  let isNew = false;
  const isOwner = (info.email || '').toLowerCase() === OWNER_EMAIL;
  if (!user) {
    const id = randHex(8);
    await env.DB.prepare(
      'INSERT INTO users (id, google_id, name, email, avatar, created_at, lim_parse, lim_coach, lim_suggest)' +
      ' VALUES (?,?,?,?,?,?,?,?,?)'
    ).bind(id, info.sub, info.name || '', info.email || '', info.picture || '', now,
      isOwner ? LIMITS_OWNER : LIMITS_DEFAULT.parse, isOwner ? LIMITS_OWNER : LIMITS_DEFAULT.coach,
      isOwner ? LIMITS_OWNER : LIMITS_DEFAULT.suggest).run();
    user = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(id).first();
    isNew = true;
  } else if (isOwner && (user.lim_parse == null || user.lim_parse < LIMITS_OWNER)) {
    await env.DB.prepare('UPDATE users SET lim_parse = ?, lim_coach = ?, lim_suggest = ? WHERE id = ?')
      .bind(LIMITS_OWNER, LIMITS_OWNER, LIMITS_OWNER, user.id).run();
    user.lim_parse = LIMITS_OWNER; user.lim_coach = LIMITS_OWNER; user.lim_suggest = LIMITS_OWNER;
  }
  // First owner sign-in claims the pre-auth workout history.
  if (isOwner) {
    await env.DB.prepare('UPDATE workouts SET user_id = ? WHERE user_id IS NULL').bind(user.id).run();
    await env.DB.prepare('UPDATE notes SET user_id = ? WHERE user_id IS NULL').bind(user.id).run();
  }
  const token = randHex(32);
  const sha = await sha256Hex(token);
  const exp = new Date(Date.now() + 90 * 864e5).toISOString();
  await env.DB.prepare(
    'INSERT INTO sessions (token_sha, user_id, created_at, expires_at) VALUES (?,?,?,?)'
  ).bind(sha, user.id, now, exp).run();
  return json({
    ok: true, is_new: isNew, session_token: token,
    user: { id: user.id, name: user.name, email: user.email, avatar: user.avatar },
  });
}

async function handleLogout(request, env) {
  const user = await resolveUser(request, env);
  if (user) {
    const h = request.headers.get('Authorization') || '';
    const m = h.match(/^Bearer\s+(.+)$/i);
    if (m) await env.DB.prepare('DELETE FROM sessions WHERE token_sha = ?').bind(await sha256Hex(m[1].trim())).run();
  }
  return json({ ok: true });
}

function userLimits(user) {
  return {
    parse: user.lim_parse != null ? user.lim_parse : LIMITS_DEFAULT.parse,
    coach: user.lim_coach != null ? user.lim_coach : LIMITS_DEFAULT.coach,
    suggest: user.lim_suggest != null ? user.lim_suggest : LIMITS_DEFAULT.suggest,
  };
}

async function checkLimit(env, user, field) {
  // field: 'parse' | 'coach'
  const limits = userLimits(user);
  const limit = limits[field];
  const today = ptDate();
  const col = field + '_count';
  await env.DB.prepare(
    'INSERT INTO rate_limits (user_id, date, ' + col + ') VALUES (?,?,1)' +
    ' ON CONFLICT (user_id, date) DO UPDATE SET ' + col + ' = COALESCE(' + col + ',0)+1'
  ).bind(user.id, today).run();
  const row = await env.DB.prepare('SELECT ' + col + ' AS n FROM rate_limits WHERE user_id = ? AND date = ?')
    .bind(user.id, today).first();
  const n = row ? row.n : 1;
  if (n > limit) {
    return json({
      error: 'Daily limit of ' + limit + ' reached. Resets tomorrow.',
      code: 'RATE_LIMITED', rate_limited: true,
    }, 429);
  }
  return null;
}

async function handleUsage(env, user) {
  const today = ptDate();
  const row = await env.DB.prepare('SELECT * FROM rate_limits WHERE user_id = ? AND date = ?')
    .bind(user.id, today).first();
  return json({
    usage: { parse: (row && row.parse_count) || 0, coach: (row && row.coach_count) || 0, suggest: (row && row.suggest_count) || 0 },
    limits: userLimits(user),
  });
}

/* ---------- end auth ---------- */

async function handleApi(request, env, url) {
  try {
    return await handleApiInner(request, env, url);
  } catch (e) {
    // Never leak an HTML error page to the client — it breaks .json() parsing.
    // Also persist the stack so we can diagnose without asking the user to retry blind.
    const detail = String((e && e.stack) || (e && e.message) || e).slice(0, 2000);
    try {
      await env.DB.prepare(
        'CREATE TABLE IF NOT EXISTS error_log (id INTEGER PRIMARY KEY, created_at TEXT, source TEXT, message TEXT)'
      ).run();
      await env.DB.prepare(
        'INSERT INTO error_log (created_at, source, message) VALUES (?,?,?)'
      ).bind(new Date().toISOString(), 'handleApi:' + url.pathname, detail).run();
    } catch (e2) { /* logging must never throw */ }
    return json({ error: 'server_error', message: String((e && e.message) || e) }, 500);
  }
}

async function handleApiInner(request, env, url) {
  const path = url.pathname;

  if (path === '/api/auth/google' && request.method === 'POST') {
    return handleGoogleAuth(request, env);
  }
  if (path === '/api/auth/logout' && request.method === 'POST') {
    return handleLogout(request, env);
  }
  if (path === '/api/auth/config' && request.method === 'GET') {
    return json({ google_client_id: googleClientId(env) });
  }

  await ensureAuthSchema(env);
  const user = await resolveUser(request, env);
  if (!user) {
    return json({ error: 'Please sign in.', code: 'AUTH_REQUIRED' }, 401);
  }
  const uid = user.id;

  if (path === '/api/usage' && request.method === 'GET') {
    return handleUsage(env, user);
  }

  if (path === '/api/workouts' && request.method === 'GET') {
    const rows = await env.DB.prepare(
      'SELECT w.id, w.date, w.title, w.body_weight_lb, w.body_weight_source, w.duration_min, w.calories, w.steps,' +
      ' (SELECT COUNT(*) FROM sets s WHERE s.workout_id = w.id) AS set_count,' +
      ' (SELECT COUNT(DISTINCT s.exercise) FROM sets s WHERE s.workout_id = w.id) AS exercise_count' +
      ' FROM workouts w WHERE w.user_id = ? ORDER BY w.date DESC, w.id DESC'
    ).bind(uid).all();
    return json(rows.results);
  }

  let m = path.match(/^\/api\/workout\/(\d+)$/);
  if (m) {
    const id = Number(m[1]);
    const w = await env.DB.prepare('SELECT * FROM workouts WHERE id = ? AND user_id = ?').bind(id, uid).first();
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
      'SELECT s.exercise AS name, COUNT(DISTINCT s.workout_id) AS workouts, COUNT(*) AS sets' +
      ' FROM sets s JOIN workouts w ON w.id = s.workout_id WHERE w.user_id = ?' +
      ' GROUP BY s.exercise ORDER BY workouts DESC, name'
    ).bind(uid).all();
    return json(rows.results);
  }

  if (path === '/api/exercise') {
    const name = url.searchParams.get('name');
    if (!name) return json({ error: 'missing name' }, 400);
    const rows = await env.DB.prepare(
      'SELECT w.date, w.body_weight_lb, s.set_index, s.exercise_index, s.reps, s.weight, s.unit, s.per_hand, s.total_lb,' +
      ' s.bodyweight, s.added_weight_lb, s.to_failure, s.prefix' +
      ' FROM sets s JOIN workouts w ON w.id = s.workout_id' +
      ' WHERE s.exercise = ? AND w.user_id = ? ORDER BY w.date, s.set_index'
    ).bind(name, uid).all();
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
      ' WHERE body_weight_lb IS NOT NULL AND user_id = ? ORDER BY date'
    ).bind(uid).all();
    return json(rows.results);
  }

  if (path === '/api/notes') {
    const rows = await env.DB.prepare('SELECT * FROM notes WHERE user_id = ? ORDER BY date').bind(uid).all();
    return json(rows.results);
  }

  if (path === '/api/backfill-weights' && request.method === 'POST') {
    const missing = await env.DB.prepare(
      "SELECT id, date FROM workouts WHERE body_weight_lb IS NULL AND user_id = ? ORDER BY date"
    ).bind(uid).all();
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

  if (path === '/api/parse' && request.method === 'POST') {
    return handleParse(request, env, user);
  }

  if (path === '/api/workouts' && request.method === 'POST') {
    return handleSaveWorkout(request, env, user);
  }

  if (path === '/api/coach' && request.method === 'POST') {
    return handleCoach(request, env, user);
  }

  if (path === '/api/suggest' && request.method === 'POST') {
    return handleSuggest(request, env, user);
  }

  return json({ error: 'not found' }, 404);
}
