#!/usr/bin/env python3
"""Seed the workout-log D1 database from transcribed notebook batches.

Source of truth for the raw transcriptions is data/batch{1..6}.json
(57 unique notebook spreads, 2026-04-23 -> 2026-10-03).

Usage:
  python3 tools/seed.py --list-names    # print distinct exercise names for canonical review
  python3 tools/seed.py --insert        # insert everything (wipes tables first)

Requires Cloudflare API access: set CF_API to a cf-api-style client, or make
sure `cf-api` is on PATH (the local skill at ~/workspace/skills/cloudflare).
"""
import glob
import json
import os
import re
import shutil
import subprocess
import sys

ACCOUNT = "49f1f72b4dae679753d12e26aed81221"
DB = "ff8e23d2-1340-4f7a-9d7b-8ec86fb8b0e8"
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "data")
KG = 2.20462

# Explicit canonical overrides, reviewed from --list-names output.
# Grip variants stay split (wide/neutral/close are different exercises).
CANON = {
    # --- bench / press ---
    "Bench": "Bench Press",
    "WG Bench": "Bench Press (Wide Grip)",
    "Flat WG Bench": "Bench Press (Wide Grip)",
    "Close Grip Bench": "Close Grip Bench Press",
    "Tricep Near Grip Bench": "Close Grip Bench Press",
    "Incline Bench": "Incline Bench Press",
    "Cambered Bench": "Cambered Bench Press",
    "Cambered Incline": "Cambered Incline Press",
    "DB Bench": "DB Bench Press",
    "DB Flat Bench": "DB Bench Press",
    "DB Press": "DB Bench Press",
    "DB Incline": "DB Incline Press",
    "DB Incline Bench": "DB Incline Press",
    "Incline DB": "DB Incline Press",
    "Incline DB Bench": "DB Incline Press",
    "Barbell Press": "Barbell Overhead Press",
    "Shoulder Barbell Press": "Barbell Overhead Press",
    "Shoulder Press Barbell": "Barbell Overhead Press",
    # --- pull-up ---
    "Wide Grip Pullup": "Pull-Up (Wide Grip)",
    "Wide Pullup": "Pull-Up (Wide Grip)",
    "WG Pullup": "Pull-Up (Wide Grip)",
    "Neutral Grip Pullup": "Pull-Up (Neutral Grip)",
    "OG Pullup": "Pull-Up",  # user: OG = regular pullup (2026-10-03)
    # --- rows ---
    "Cambered Rows": "Cambered Row",
    "DB Row": "DB Row",
    "DB Rows": "DB Row",
    "Cable Lat Pulldown": "Lat Pulldown",
    # --- curls ---
    "Curls": "Barbell Curl",
    "Curl": "Barbell Curl",
    "Bar Curl": "EZ Bar Curl",
    "Curl Bar": "EZ Bar Curl",
    "Curl EZ": "EZ Bar Curl",
    "EZ Curl": "EZ Bar Curl",
    "Ez Bar Curl": "EZ Bar Curl",
    "EZ Bar Curl": "EZ Bar Curl",
    "Preacher": "Preacher Curl",
    "Prison Curls": "Concentration Curl",  # user: prison curls = concentration curls (2026-10-03)
    "Preacher Curls": "Preacher Curl",
    "Preacher EZ Curl": "EZ Bar Preacher Curl",
    "Preacher Ez Curl": "EZ Bar Preacher Curl",
    "EZ Preacher": "EZ Bar Preacher Curl",
    "Ez Bar Preacher Curl": "EZ Bar Preacher Curl",
    "DB Curls": "DB Curl",
    "DB Curl Incline": "DB Incline Curl",
    "DB Curl Preacher": "DB Preacher Curl",
    "DB Incline Curl": "DB Incline Curl",
    "Incline DB Curl": "DB Incline Curl",
    "Incline Curl": "DB Incline Curl",
    "DB Preacher": "DB Preacher Curl",
    "Cable Preacher Curl": "Cable Preacher Curl",
    "Concentration Preacher Curl": "Concentration Preacher Curl",
    "DB Hammer Curls": "DB Hammer Curl",
    # --- triceps ---
    "Skull Crushers": "Skull Crusher",
    "Rope Tricep": "Rope Triceps Pushdown",
    "Rope Tricep Pulldown": "Rope Triceps Pushdown",
    "Rope Tricep Pushdown": "Rope Triceps Pushdown",
    "Rope Extended Tricep Pushdown": "Rope Triceps Pushdown",
    "Tri Pulldown": "Triceps Pushdown",
    "Tricep Pulldown": "Triceps Pushdown",
    "Tricep Pushdown": "Triceps Pushdown",
    "Tricep Extension": "Triceps Extension",
    "DB Tricep": "DB Overhead Triceps Extension",
    "DB Tricep Extension": "DB Overhead Triceps Extension",
    "DB Overhead Tricep Raises": "DB Overhead Triceps Extension",
    "Overhead DB Tricep Extension": "DB Overhead Triceps Extension",
    "Seated DB Overhead Tricep Raise": "DB Overhead Triceps Extension",
    "One Handed Cable Tricep Pushdown": "One-Handed Cable Triceps Pushdown",
    "Overhead One-handed Cable Tricep Pushdown": "Overhead One-Handed Cable Triceps Pushdown",
    # --- lateral raises ---
    "Lat Raises": "Lateral Raise",
    "Lateral Raises": "Lateral Raise",
    "Side Delt Raise": "Lateral Raise",
    "Side Lat Raise": "Lateral Raise",
    "DB Lateral Raises": "DB Lateral Raise",
    "DB Raises": "DB Lateral Raise",
    # --- deadlift / hinge ---
    "RDL Barbell": "Romanian Deadlift",
    "Romanian Deadlift": "Romanian Deadlift",
    "Straight Leg Deadlift": "Romanian Deadlift",
    "DB Straight Leg DL": "DB Romanian Deadlift",
    "DB Straight Leg Deadlift": "DB Romanian Deadlift",
    "Straight Leg DB Deadlift": "DB Romanian Deadlift",
    "DB RDL": "DB Romanian Deadlift",
    "Hex Straight Leg DL": "Hex RDL",
    "Hex Shoulder Shrug": "Hex Bar Shrug",
    "Hex Shoulder Shrugs": "Hex Bar Shrug",
    # --- squat / lunge ---
    "Squat": "Barbell Squat",
    "90° Squat": "Barbell Squat",  # user: 90-degree squat is just squat (2026-10-03)
    "Bulgarian Split": "Bulgarian Split Squat",
    "Bulgarian Split Lunge": "Bulgarian Split Squat",
    "Bulgarian Split Squat DB": "Bulgarian Split Squat",
    "DB One Leg Lunge": "DB Lunge",
    "DB One leg lunge": "DB Lunge",
    "One Leg Raised Lunge": "Lunge",
    # --- calves ---
    "Calf Raises": "Calf Raise",
    "Heel Raises": "Calf Raise",
    "DB Calf Raises": "DB Calf Raise",
    # --- cable ---
    "Cable Lat Crossover": "Cable Crossover",
    "Cross Cable": "Cable Crossover",
    "Cable Lat Prayer": "Lat Prayer",
    # --- misc ---
    "Face Pulls": "Face Pull",
    "Face Puller": "Face Pull",
    "Face Pullup": "Face Pull",
    "Trap Raiser": "Trap Raise",
    "Trap Raises": "Trap Raise",
    "Barbell Thrust": "Barbell Hip Thrust",
}

# Only these movement families get split by grip prefix (WG/NG/CG/CC).
_GRIP_FAMILY = re.compile(r"bench|press|pull-?up|pulldown|row", re.I)

# Explicit unit overrides: (unit, per_hand). For exercises whose unit can't be
# inferred from the name.
UNIT_OVERRIDE = {
    "Prison Curls": ("kg", 0),  # written "10kg" in the notebook; single implement
}

ILLEGIBLE_RE = re.compile(r"illegible", re.I)


def canon_base(raw):
    n = " ".join(raw.strip().split())
    n = CANON.get(n, n)
    # generic normalizations
    n = re.sub(r"\bDb\b", "DB", n)
    n = re.sub(r"\bBw\b", "BW", n)
    n = re.sub(r"(?i)^pullups?$", "Pull-Up", n)
    n = re.sub(r"(?i)^pull ups?$", "Pull-Up", n)
    n = re.sub(r"(?i)^pushups?$", "Push-Up", n)
    n = re.sub(r"(?i)^dips$", "Dips", n)
    n = re.sub(r"(?i)^facepulls?$", "Face Pull", n)
    n = re.sub(r"(?i)^rdl$", "Romanian Deadlift", n)
    return n


def grip_suffix(base, prefix):
    # Grip variants are distinct exercises: a "WG" (wide grip) prefix on a set
    # puts it in e.g. "Bench Press (Wide Grip)" — but only for press/pull
    # families, so a WG prefix on e.g. dips doesn't fork the exercise.
    # "wc" is a transcription misread of "wg" (user confirmed 2026-10-03).
    if not _GRIP_FAMILY.search(base):
        return ""
    pl = (prefix or "").strip().lower()
    if pl in ("wg", "wc"):
        return " (Wide Grip)"
    if pl in ("cg", "cc", "close grip"):
        return " (Close Grip)"
    if pl in ("ng", "neutral grip"):
        return " (Neutral Grip)"
    return ""


# User directive 2026-10-03: all barbell incline work is one exercise called
# "Incline" — this covers the cambered-bar incline (everything since May) and
# all grip variants. DB Incline Press stays separate (dumbbell variant).
_INCLINE_NAMES = {
    "Incline Bench Press",
    "Incline Bench Press (Wide Grip)",
    "Incline Bench Press (Close Grip)",
    "Incline Bench Press (Neutral Grip)",
    "Cambered Incline Press",
}


def merge_incline(name):
    return "Incline" if name in _INCLINE_NAMES else name


def canon_name(raw, prefixes=()):
    # Backwards-compatible wrapper: single name for a whole block (used by --list-names).
    base = canon_base(raw)
    for p in prefixes:
        gs = grip_suffix(base, p)
        if gs:
            return base + gs
    return base


def qstr(v):
    if v is None:
        return "NULL"
    if isinstance(v, (int, float)):
        return repr(v)
    return "'" + str(v).replace("'", "''") + "'"


CF_API_BIN = os.environ.get("CF_API") or shutil.which("cf-api") or \
    os.path.expanduser("~/workspace/skills/cloudflare/bin/cf-api")


def cf_query(sql):
    import tempfile, os
    with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as fh:
        json.dump({"sql": sql}, fh)
        tmp = fh.name
    try:
        out = subprocess.run(
            [CF_API_BIN, "POST",
             f"/accounts/{ACCOUNT}/d1/database/{DB}/query",
             "--data", "@" + tmp],
            capture_output=True, text=True)
    finally:
        os.unlink(tmp)
    raw = (out.stdout or "").strip() or (out.stderr or "").strip()
    try:
        d = json.loads(raw)
    except Exception:
        print("CF API RAW:", raw[:500])
        raise
    if not d.get("success"):
        print("QUERY FAILED:", sql[:200])
        print(json.dumps(d)[:2000])
        raise SystemExit(1)
    return d



SCHEMA = """
CREATE TABLE IF NOT EXISTS workouts (
  id INTEGER PRIMARY KEY,
  date TEXT,
  body_weight_lb REAL,
  body_weight_source TEXT,
  duration_min INTEGER,
  notes TEXT
);
CREATE TABLE IF NOT EXISTS sets (
  id INTEGER PRIMARY KEY,
  workout_id INTEGER NOT NULL REFERENCES workouts(id),
  exercise TEXT NOT NULL,
  exercise_raw TEXT,
  set_index INTEGER NOT NULL,
  exercise_index INTEGER,
  reps INTEGER,
  weight REAL,
  unit TEXT,
  per_hand INTEGER,
  to_failure INTEGER,
  dropset_to_bw INTEGER,
  prefix TEXT,
  total_lb REAL,
  note TEXT
);
CREATE TABLE IF NOT EXISTS cardio (
  id INTEGER PRIMARY KEY,
  workout_id INTEGER NOT NULL REFERENCES workouts(id),
  kind TEXT,
  distance_mi REAL,
  duration_min REAL,
  steps INTEGER,
  note TEXT
);
CREATE TABLE IF NOT EXISTS notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT,
  text TEXT
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  created_at TEXT DEFAULT (datetime('now'))
);
"""

def ensure_schema():
    for stmt in [s.strip() for s in SCHEMA.strip().split(";") if s.strip()]:
        cf_query(stmt)


def load_batches():
    pages = []
    for f in sorted(glob.glob(os.path.join(DATA, "batch*.json"))):
        d = json.load(open(f))
        for img in d["images"]:
            for p in img["pages"]:
                p["_file"] = img["file"]
                pages.append(p)
    return pages


def list_names():
    pages = load_batches()
    names = {}
    prefixes = {}
    for p in pages:
        for ex in p.get("exercises", []):
            names.setdefault(ex["name"], 0)
            names[ex["name"]] += len(ex["sets"])
            for s in ex["sets"]:
                if s.get("prefix"):
                    prefixes.setdefault(ex["name"], set()).add(s["prefix"])
    for n in sorted(names):
        px = ("  prefixes: " + ",".join(sorted(prefixes[n]))) if n in prefixes else ""
        print(f"{names[n]:4d}  {n}{px}")
    print(f"\n{len(pages)} pages, {sum(names.values())} sets")


def infer_unit_and_hands(ex_name, raw_name=None):
    if raw_name in UNIT_OVERRIDE:
        return UNIT_OVERRIDE[raw_name]
    if ex_name in UNIT_OVERRIDE:
        return UNIT_OVERRIDE[ex_name]
    low = ex_name.lower()
    # crude but effective: DB/dumbbell anywhere in the name
    is_db = bool(re.search(r"\bdb\b|dumbbell", low))
    if not is_db:
        return "lb", 0
    if "goblet" in low:
        return "kg", 0  # single DB held with both hands
    return "kg", 1


def set_total_lb(ex_name, s):
    if s.get("bodyweight"):
        return s.get("added_weight")  # external load only; pure BW -> None
    w = s.get("weight")
    if w is None:
        return None
    unit, per_hand = infer_unit_and_hands(ex_name)
    if unit == "kg":
        lb = w * KG
        return round(lb * 2, 1) if per_hand else round(lb, 1)
    return round(w, 1)


def do_insert():
    pages = load_batches()
    print(f"loaded {len(pages)} pages")

    # sanity: date coverage
    dates = sorted({p["date"] for p in pages if p.get("date")})
    print(f"date range: {dates[0]} .. {dates[-1]}, {len(dates)} distinct dates")
    illegible = 0

    ensure_schema()
    cf_query("DELETE FROM sets")
    cf_query("DELETE FROM cardio")
    cf_query("DELETE FROM workouts")
    cf_query("DELETE FROM notes")

    wid = 0
    sid = 0
    cid = 0
    set_rows = []
    for p in pages:
        ptype = p.get("page_type", "workout")
        if ptype == "note":
            txt = p.get("notes", "")
            cf_query(f"INSERT INTO notes (date, text) VALUES ({qstr(p.get('date'))}, {qstr(txt)})")
            continue
        wid += 1
        title = p.get("title", "") or ""
        if ptype == "cardio_only" and not title:
            title = "Cardio"
        if not p.get("date"):
            raise SystemExit(f"dateless workout page in {p.get('_file')} side={p.get('side')}")
        bw_src = "notebook" if p.get("body_weight_lb") is not None else None
        cf_query(
            "INSERT INTO workouts (id, date, body_weight_lb, body_weight_source, duration_min,"
            f" calories, steps, title, notes) VALUES ({wid}, {qstr(p.get('date'))},"
            f" {qstr(p.get('body_weight_lb'))}, {qstr(bw_src)},"
            f" {qstr(p.get('duration_min'))}, {qstr(p.get('calories'))}, {qstr(p.get('steps'))},"
            f" {qstr(title)}, {qstr(p.get('notes', ''))})")
        for ex_i, ex in enumerate(p.get("exercises", [])):
            raw = ex["name"]
            base = canon_base(raw)
            # Partition the block's sets by grip: one page can hold several
            # grip variants (e.g. standard + close-grip incline bench).
            parts = {}
            for s in ex["sets"]:
                gs = grip_suffix(base, s.get("prefix"))
                parts.setdefault(gs, []).append(s)
            for gs, ssets in parts.items():
                cn = merge_incline(base + gs)
                unit, per_hand = infer_unit_and_hands(cn, raw)
                for i, s in enumerate(ssets):
                    sid += 1
                    if s.get("note") and ILLEGIBLE_RE.search(s["note"]):
                        illegible += 1
                    bw = 1 if s.get("bodyweight") else 0
                    tl = set_total_lb(cn, s)
                    set_rows.append(
                        f"({sid}, {wid}, {qstr(cn)}, {qstr(raw)}, {i}, {ex_i}, {qstr(s.get('reps'))},"
                        f" {qstr(s.get('weight'))}, {qstr(unit if not bw else None)},"
                        f" {per_hand if not bw else 0}, {qstr(tl)}, {bw},"
                        f" {qstr(s.get('added_weight'))}, 0,"
                        f" {1 if s.get('to_failure') else 0},"
                        f" {qstr(s.get('prefix') or '')}, {qstr(s.get('note') or '')})")
                if len(set_rows) >= 250:
                    cf_query("INSERT INTO sets (id, workout_id, exercise, exercise_raw, set_index, exercise_index, reps,"
                             " weight, unit, per_hand, total_lb, bodyweight, added_weight_lb, warmup,"
                             f" to_failure, prefix, note) VALUES {', '.join(set_rows)}")
                    set_rows = []
        for c in p.get("cardio", []):
            cid += 1
            cf_query(
                f"INSERT INTO cardio (id, workout_id, kind, distance_mi, duration_min, steps, note)"
                f" VALUES ({cid}, {wid}, {qstr(c.get('kind'))}, {qstr(c.get('distance_mi'))},"
                f" {qstr(c.get('duration_min'))}, {qstr(c.get('steps'))}, {qstr(c.get('note', ''))})")

    if set_rows:
        cf_query("INSERT INTO sets (id, workout_id, exercise, exercise_raw, set_index, exercise_index, reps,"
                 " weight, unit, per_hand, total_lb, bodyweight, added_weight_lb, warmup,"
                 f" to_failure, prefix, note) VALUES {', '.join(set_rows)}")

    r = cf_query("SELECT COUNT(*) c FROM workouts")["result"][0]["results"][0]["c"]
    r2 = cf_query("SELECT COUNT(*) c FROM sets")["result"][0]["results"][0]["c"]
    r3 = cf_query("SELECT COUNT(*) c FROM cardio")["result"][0]["results"][0]["c"]
    r4 = cf_query("SELECT COUNT(*) c FROM notes")["result"][0]["results"][0]["c"]
    print(f"inserted: {r} workouts, {r2} sets, {r3} cardio rows, {r4} notes; illegible flags: {illegible}")


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "--list-names":
        list_names()
    elif len(sys.argv) > 1 and sys.argv[1] == "--insert":
        do_insert()
    else:
        print("usage: insert.py --list-names | --insert")
