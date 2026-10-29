-- Relations between entries, the trail of what clients searched and read, and the search query
-- builder (spec B1 «Contradicciones», B3 minimum).

CREATE TABLE relations (
  id            text PRIMARY KEY,
  brain_id      text NOT NULL REFERENCES brains(id) ON DELETE CASCADE,
  from_id       text NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
  to_id         text NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
  kind          text NOT NULL CHECK (kind IN ('contradicts', 'supersedes', 'not_related')),
  -- pending_person: an agent tried to supersede or dismiss a person's correction; a person decides.
  status        text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'pending_person', 'rejected')),
  reason        text NOT NULL DEFAULT '' CHECK (length(reason) <= 500),
  created_by    text NOT NULL REFERENCES accounts(id),
  credential_id text REFERENCES credentials(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL,
  CHECK (from_id <> to_id)
);
CREATE INDEX relations_brain ON relations (brain_id, created_at);
CREATE INDEX relations_pair ON relations (least(from_id, to_id), greatest(from_id, to_id));

-- What a client searched, read or asked as context; identifiers of what came back, never content.
CREATE TABLE trail (
  id            bigserial PRIMARY KEY,
  brain_id      text NOT NULL REFERENCES brains(id) ON DELETE CASCADE,
  at            timestamptz NOT NULL,
  account_id    text NOT NULL,
  credential_id text NOT NULL,
  ref           text,
  kind          text NOT NULL CHECK (kind IN ('search', 'read', 'context')),
  query         text,
  result_ids    text[] NOT NULL DEFAULT '{}'
);
CREATE INDEX trail_brain ON trail (brain_id, at);
CREATE INDEX trail_ref ON trail (brain_id, ref) WHERE ref IS NOT NULL;
CREATE INDEX trail_results ON trail USING gin (result_ids);

-- A search request as a tsquery over the three dictionaries of brain_tsv: any of the words, every
-- quoted phrase, none of the excluded words — matched in at least one dictionary.
CREATE FUNCTION brain_query(any_words text[], phrases text[], excluded text[]) RETURNS tsquery
  LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE
AS $$
DECLARE
  cfg regconfig;
  per tsquery;
  part tsquery;
  w text;
  result tsquery := NULL;
BEGIN
  FOREACH cfg IN ARRAY ARRAY['simple', 'spanish', 'english']::regconfig[] LOOP
    per := NULL;
    IF coalesce(array_length(any_words, 1), 0) > 0 THEN
      part := NULL;
      FOREACH w IN ARRAY any_words LOOP
        IF numnode(plainto_tsquery(cfg, brain_unaccent(w))) > 0 THEN
          part := CASE WHEN part IS NULL THEN plainto_tsquery(cfg, brain_unaccent(w))
                       ELSE part || plainto_tsquery(cfg, brain_unaccent(w)) END;
        END IF;
      END LOOP;
      per := part;
    END IF;
    IF coalesce(array_length(phrases, 1), 0) > 0 THEN
      FOREACH w IN ARRAY phrases LOOP
        IF numnode(phraseto_tsquery(cfg, brain_unaccent(w))) > 0 THEN
          per := CASE WHEN per IS NULL THEN phraseto_tsquery(cfg, brain_unaccent(w))
                      ELSE per && phraseto_tsquery(cfg, brain_unaccent(w)) END;
        END IF;
      END LOOP;
    END IF;
    IF per IS NOT NULL AND coalesce(array_length(excluded, 1), 0) > 0 THEN
      FOREACH w IN ARRAY excluded LOOP
        IF numnode(plainto_tsquery(cfg, brain_unaccent(w))) > 0 THEN
          per := per && !! plainto_tsquery(cfg, brain_unaccent(w));
        END IF;
      END LOOP;
    END IF;
    IF per IS NOT NULL THEN
      result := CASE WHEN result IS NULL THEN per ELSE result || per END;
    END IF;
  END LOOP;
  RETURN result;
END
$$;
