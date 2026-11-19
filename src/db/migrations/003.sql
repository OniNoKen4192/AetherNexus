-- 003: a ship is a lasting record of what it is, and a voyage records what it carries.
--   ships.class   becomes ships.job: 'freighter' -> 'delivery', 'customs' -> 'customs', 'carrier' -> 'transfer', 'surveyor' -> 'survey'.
--                 A freighter is a hull in the catalogue from here on; the job a ship does is a delivery.
--   ships gains   faction (the design language of its provider), weight (how heavy a job it flies) and formation (a full JSON
--                 copy of the catalogue entry it was commissioned with, so a later catalogue edit never changes a ship).
--   voyages gains cargo (JSON, NULL for a voyage that carries none).
-- Ships registered before this migration get: faction = their fleet, weight 'standard', and the legacy formation for their job.
-- The formation text below must stay byte-equal to JSON.stringify(legacyShip(...).formation) in src/core/fleet.ts: the
-- 'ship.registered' reducer writes the same rows on a rebuild (tests/db/migration-003.test.mjs pins the two together).
--
-- SQLite cannot rename a column that a CHECK names in place without rewriting it, so ships is rebuilt by 002's
-- set-aside-and-refill method. The migration runs inside one transaction with foreign keys ON throughout: rows are set aside
-- in holding tables (which carry no constraints), the children are emptied first (verdicts -> voyages) so no row ever points
-- at a missing parent, ships is dropped, created and refilled, then voyages and verdicts are refilled. voyages itself is not
-- rebuilt: it only gains a nullable column. `ORDER BY rowid` keeps the row order the projection dump relies on. If any step
-- fails the whole transaction rolls back and the database stays at schema 2.

CREATE TABLE verdicts_hold AS SELECT * FROM verdicts ORDER BY rowid;
CREATE TABLE voyages_hold  AS SELECT * FROM voyages  ORDER BY rowid;
CREATE TABLE ships_hold    AS SELECT * FROM ships    ORDER BY rowid;

DELETE FROM verdicts;
DELETE FROM voyages;
DROP TABLE ships;

CREATE TABLE ships    (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE,
                       job TEXT NOT NULL CHECK (job IN ('delivery','customs','transfer','survey')),
                       fleet TEXT NOT NULL,
                       faction TEXT NOT NULL,
                       weight TEXT NOT NULL,
                       formation TEXT NOT NULL CHECK (json_valid(formation)),
                       status TEXT NOT NULL CHECK (status IN ('idle','assigned','adrift','quarantined','retired')),
                       voyage_count INTEGER NOT NULL DEFAULT 0,
                       last_event_id INTEGER NOT NULL REFERENCES events(id));
ALTER TABLE voyages ADD COLUMN cargo TEXT CHECK (cargo IS NULL OR json_valid(cargo));

INSERT INTO ships (id, name, job, fleet, faction, weight, formation, status, voyage_count, last_event_id)
SELECT id, name,
       CASE class WHEN 'freighter' THEN 'delivery' WHEN 'customs' THEN 'customs' WHEN 'carrier' THEN 'transfer' WHEN 'surveyor' THEN 'survey' END,
       fleet, fleet, 'standard',
       CASE class
         WHEN 'freighter' THEN '{"id":"legacy-delivery","name":"Freighter","vessels":[{"hull":"freighter","count":1,"role":"lead"}]}'
         WHEN 'customs'   THEN '{"id":"legacy-customs","name":"Customs cutter","vessels":[{"hull":"customs-cutter","count":1,"role":"lead"}]}'
         WHEN 'carrier'   THEN '{"id":"legacy-transfer","name":"Carrier","vessels":[{"hull":"carrier","count":1,"role":"lead"}]}'
         WHEN 'surveyor'  THEN '{"id":"legacy-survey","name":"Surveyor","vessels":[{"hull":"surveyor","count":1,"role":"lead"}]}'
       END,
       status, voyage_count, last_event_id
FROM ships_hold ORDER BY rowid;
INSERT INTO voyages  SELECT *, NULL FROM voyages_hold  ORDER BY rowid;
INSERT INTO verdicts SELECT *       FROM verdicts_hold ORDER BY rowid;

DROP TABLE verdicts_hold;
DROP TABLE voyages_hold;
DROP TABLE ships_hold;
