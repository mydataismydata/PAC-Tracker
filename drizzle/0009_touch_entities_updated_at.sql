-- Keep entities.updated_at honest, the same way transactions already are.
--
-- The column existed and had a default, but nothing maintained it after the
-- insert. Anything that corrected an entity in place — a kind fixed by hand, a
-- name put right — left the timestamp at whenever the row was first written,
-- and the export that carries changes to the deployment box selects on exactly
-- that column. The correction stayed on this machine and no one was told.
DROP TRIGGER IF EXISTS "entities_touch_updated_at" ON "entities";--> statement-breakpoint
CREATE TRIGGER "entities_touch_updated_at"
BEFORE UPDATE ON "entities"
FOR EACH ROW EXECUTE FUNCTION "touch_updated_at"();
