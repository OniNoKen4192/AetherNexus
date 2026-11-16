-- 002: two new statuses, each with one meaning.
--   moons.status   gains 'awaiting_pickup' — a freighter ran out of fuel; the cargo at the moon waits for the next one.
--   voyages.status gains 'out_of_fuel'     — the voyage ended at an empty pool; nobody has to look at it.
-- Nothing else about either table changes: the definitions below are 001's with only the status list widened.
--
-- SQLite cannot alter a CHECK in place, so both tables are rebuilt. The migration runs inside one transaction
-- with foreign keys ON and they stay on throughout: rows are set aside in holding tables (which carry no
-- constraints), the tables are emptied and dropped children first (verdicts -> voyages -> moons) so no row ever
-- points at a missing parent, then created and refilled parents first. `ORDER BY rowid` keeps the row order the
-- projection dump relies on. If any step fails the whole transaction rolls back and the database stays at schema 1.

CREATE TABLE verdicts_hold AS SELECT * FROM verdicts ORDER BY rowid;
CREATE TABLE voyages_hold  AS SELECT * FROM voyages  ORDER BY rowid;
CREATE TABLE moons_hold    AS SELECT * FROM moons    ORDER BY rowid;

DELETE FROM verdicts;
DROP TABLE voyages;
DROP TABLE moons;

CREATE TABLE moons    (id TEXT PRIMARY KEY, planet_id TEXT NOT NULL REFERENCES planets(id),
                       name TEXT NOT NULL, orbit_index INTEGER NOT NULL,
                       body_status TEXT NOT NULL CHECK (body_status IN ('barren','assigned','settled')),
                       task_id TEXT UNIQUE, assignment_id INTEGER,
                       spec_path TEXT, spec_sha TEXT, touch TEXT CHECK (touch IS NULL OR json_valid(touch)),
                       depends_on TEXT CHECK (depends_on IS NULL OR json_valid(depends_on)), tier TEXT, round INTEGER NOT NULL DEFAULT 0,
                       worktree TEXT, branch TEXT,
                       status TEXT CHECK (status IS NULL OR status IN ('emitted','gated','implementing','audited','reviewing','merged','adrift','quarantined','dropped','awaiting_pickup')),
                       park_reason TEXT,
                       last_event_id INTEGER NOT NULL REFERENCES events(id),
                       UNIQUE (planet_id, orbit_index));
CREATE TABLE voyages  (id TEXT PRIMARY KEY, ship_id TEXT NOT NULL REFERENCES ships(id),
                       moon_id TEXT REFERENCES moons(id), planet_id TEXT REFERENCES planets(id), task_id TEXT NOT NULL, assignment_id INTEGER NOT NULL,
                       role TEXT NOT NULL CHECK (role IN ('implement','review','carry','plan')), round INTEGER NOT NULL,
                       provider TEXT NOT NULL, model TEXT, session_id TEXT,
                       status TEXT NOT NULL CHECK (status IN ('launched','working','holding','cleared','en_route','docked','superseded','adrift','quarantined','out_of_fuel')),
                       launched_ts TEXT NOT NULL, returned_ts TEXT, docked_ts TEXT,
                       report TEXT CHECK (report IS NULL OR json_valid(report)), cost TEXT CHECK (cost IS NULL OR json_valid(cost)),
                       last_event_id INTEGER NOT NULL REFERENCES events(id));

INSERT INTO moons    SELECT * FROM moons_hold    ORDER BY rowid;
INSERT INTO voyages  SELECT * FROM voyages_hold  ORDER BY rowid;
INSERT INTO verdicts SELECT * FROM verdicts_hold ORDER BY rowid;

DROP TABLE verdicts_hold;
DROP TABLE voyages_hold;
DROP TABLE moons_hold;
