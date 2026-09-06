-- Officer rows that name nobody.
--
-- A committee with no chair, treasurer or agent files a word rather than an
-- empty cell, and the detail page prints that word where a name goes. Read as
-- a person it becomes an officer named "None" on 231 committees — a hub in
-- registration links, and a name in the "who runs it" panel, made out of a
-- blank. The absence of the row is the honest record.
--
-- `isOfficerPlaceholder` in src/lib/normalize.ts now drops these at ingest.
-- This clears the rows written before it existed, including three
-- "No Chairman Designated" rows that came from the bulk extract.
--
-- committee_officers ships wholesale in scripts/sync-to-vps.sh (the sync
-- truncates and replaces it), so this does not need running on the VPS.
DELETE FROM committee_officers
 WHERE normalized_name ~* '^(no +[^ ]+ +designated|not +designated|none +designated|none|vacant|n/?a|not +applicable|tbd|to +be +determined|unknown|pending)$';
