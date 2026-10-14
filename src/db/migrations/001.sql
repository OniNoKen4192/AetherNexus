CREATE TABLE events (
  id        INTEGER PRIMARY KEY,
  ts        TEXT    NOT NULL,
  kind      TEXT    NOT NULL,
  system_id TEXT, planet_id TEXT, moon_id TEXT, voyage_id TEXT, ship_id TEXT,
  task_id   TEXT,
  provider  TEXT,
  payload   TEXT    NOT NULL CHECK (json_valid(payload))
);
CREATE INDEX events_moon   ON events(moon_id, id);
CREATE INDEX events_task   ON events(task_id, id);
CREATE INDEX events_voyage ON events(voyage_id, id);
CREATE INDEX events_kind   ON events(kind, id);

CREATE TABLE systems  (id TEXT PRIMARY KEY, kind TEXT CHECK (kind IN ('feature','bug')), title TEXT, brief TEXT,
                       base_sha TEXT NOT NULL, integration_branch TEXT NOT NULL,
                       seed INTEGER NOT NULL, theme TEXT NOT NULL,
                       status TEXT NOT NULL CHECK (status IN ('open','landed','dropped')),
                       created_ts TEXT NOT NULL, landed_ts TEXT,
                       last_event_id INTEGER NOT NULL REFERENCES events(id));
CREATE TABLE planets  (id TEXT PRIMARY KEY, system_id TEXT NOT NULL REFERENCES systems(id),
                       name TEXT NOT NULL, orbit_index INTEGER NOT NULL,
                       kind TEXT NOT NULL CHECK (kind IN ('rocky','gas_giant','ice_giant','dwarf')),
                       body_status TEXT NOT NULL CHECK (body_status IN ('barren','assigned','settled')),
                       stream_id TEXT, mission TEXT,
                       territory TEXT CHECK (territory IS NULL OR json_valid(territory)), depends_on TEXT CHECK (depends_on IS NULL OR json_valid(depends_on)),
                       branch TEXT, worktree TEXT,
                       status TEXT CHECK (status IS NULL OR status IN ('open','merged','adrift','dropped')),
                       last_event_id INTEGER NOT NULL REFERENCES events(id),
                       UNIQUE (system_id, orbit_index));
CREATE TABLE moons    (id TEXT PRIMARY KEY, planet_id TEXT NOT NULL REFERENCES planets(id),
                       name TEXT NOT NULL, orbit_index INTEGER NOT NULL,
                       body_status TEXT NOT NULL CHECK (body_status IN ('barren','assigned','settled')),
                       task_id TEXT UNIQUE,
                       spec_path TEXT, spec_sha TEXT, touch TEXT CHECK (touch IS NULL OR json_valid(touch)),
                       depends_on TEXT CHECK (depends_on IS NULL OR json_valid(depends_on)), tier TEXT, round INTEGER NOT NULL DEFAULT 0,
                       worktree TEXT, branch TEXT,
                       status TEXT CHECK (status IS NULL OR status IN ('emitted','gated','implementing','audited','reviewing','merged','adrift','quarantined','dropped')),
                       park_reason TEXT,
                       last_event_id INTEGER NOT NULL REFERENCES events(id),
                       UNIQUE (planet_id, orbit_index));
CREATE TABLE ships    (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE,
                       class TEXT NOT NULL CHECK (class IN ('freighter','customs','carrier','surveyor')),
                       fleet TEXT NOT NULL,
                       status TEXT NOT NULL CHECK (status IN ('idle','assigned','adrift','quarantined','retired')),
                       voyage_count INTEGER NOT NULL DEFAULT 0,
                       last_event_id INTEGER NOT NULL REFERENCES events(id));
CREATE TABLE voyages  (id TEXT PRIMARY KEY, ship_id TEXT NOT NULL REFERENCES ships(id),
                       moon_id TEXT REFERENCES moons(id), planet_id TEXT REFERENCES planets(id), task_id TEXT NOT NULL,
                       role TEXT NOT NULL CHECK (role IN ('implement','review','carry','plan')), round INTEGER NOT NULL,
                       provider TEXT NOT NULL, model TEXT, session_id TEXT,
                       status TEXT NOT NULL CHECK (status IN ('launched','working','holding','cleared','en_route','docked','superseded','adrift','quarantined')),
                       launched_ts TEXT NOT NULL, returned_ts TEXT, docked_ts TEXT,
                       report TEXT CHECK (report IS NULL OR json_valid(report)), cost TEXT CHECK (cost IS NULL OR json_valid(cost)),
                       last_event_id INTEGER NOT NULL REFERENCES events(id));
CREATE TABLE verdicts (id INTEGER PRIMARY KEY, moon_id TEXT NOT NULL REFERENCES moons(id), task_id TEXT NOT NULL, voyage_id TEXT NOT NULL REFERENCES voyages(id),
                       verdict TEXT NOT NULL CHECK (verdict IN ('APPROVE','FIX','REJECT')), delta_spec TEXT, reasoning TEXT, round INTEGER NOT NULL,
                       last_event_id INTEGER NOT NULL REFERENCES events(id));
CREATE TABLE decisions(id INTEGER PRIMARY KEY, kind TEXT NOT NULL, target_kind TEXT NOT NULL, target_id TEXT NOT NULL, reasoning TEXT,
                       status TEXT NOT NULL CHECK (status IN ('pending','resolved')), opened_ts TEXT NOT NULL, resolved_ts TEXT,
                       human_note TEXT, outcome TEXT,
                       last_event_id INTEGER NOT NULL REFERENCES events(id));

CREATE TABLE query_stats (name TEXT PRIMARY KEY, sql TEXT NOT NULL, calls INTEGER NOT NULL, total_ms REAL NOT NULL,
                          max_ms REAL NOT NULL, last_rows INTEGER, last_ts TEXT NOT NULL);
