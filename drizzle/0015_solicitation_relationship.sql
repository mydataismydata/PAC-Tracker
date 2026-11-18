-- How each officeholder described their tie to the organization on the form:
-- Established, Maintained, Controlled, or a pair. Only someone who established
-- or controls a committee can call it theirs; "Maintained" alone is raising
-- money for it, and a person page must not count someone else's committee.
ALTER TABLE "solicitations" ADD COLUMN IF NOT EXISTS "relationship" text;
