-- F1-PR13: an agent's entry written with a short key «on behalf of» a person did not keep that person (the
-- writer always passed nobody; fixed in src/domain/entries.ts). Where it can be derived it is filled in now: the
-- entry's credential still exists, is a short key, and names someone. Nothing else changes (not updated_at: the
-- entry itself did not change), and an entry that names someone already keeps it. Running it again finds nothing.
UPDATE entries e
   SET on_behalf_id = c.on_behalf_id
  FROM credentials c
 WHERE c.id = e.credential_id
   AND c.kind = 'short'
   AND c.on_behalf_id IS NOT NULL
   AND e.on_behalf_id IS NULL;
