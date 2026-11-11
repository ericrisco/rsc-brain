-- Spec v0.6 CA16: a copy made with pg_dump restores into a new database. pg_restore runs with an empty search
-- path, so a search function that calls another one by its bare name cannot fill the generated search
-- columns of pages and entries again. Each call names its schema now; same results, still IMMUTABLE, so the
-- generated columns and their indexes stay as they are. Existing installations get the fix here.

CREATE OR REPLACE FUNCTION public.brain_unaccent(text) RETURNS text
  LANGUAGE sql IMMUTABLE PARALLEL SAFE STRICT
  AS $$ SELECT public.unaccent('public.unaccent'::regdictionary, $1) $$;

CREATE OR REPLACE FUNCTION public.brain_tsv(text) RETURNS tsvector
  LANGUAGE sql IMMUTABLE PARALLEL SAFE STRICT
  AS $$ SELECT pg_catalog.to_tsvector('pg_catalog.simple', public.brain_unaccent($1))
            || pg_catalog.to_tsvector('pg_catalog.spanish', public.brain_unaccent($1))
            || pg_catalog.to_tsvector('pg_catalog.english', public.brain_unaccent($1)) $$;

CREATE OR REPLACE FUNCTION public.brain_entry_tsv(topic text, title text, content text, tags text[]) RETURNS tsvector
  LANGUAGE sql IMMUTABLE PARALLEL SAFE
  AS $$ SELECT public.brain_tsv(coalesce(topic, '') || ' ' || title || ' ' || content || ' ' || coalesce(pg_catalog.array_to_string(tags, ' '), '')) $$;

CREATE OR REPLACE FUNCTION public.brain_page_tsv(address text, title text, summary text, body text, tags text[]) RETURNS tsvector
  LANGUAGE sql IMMUTABLE PARALLEL SAFE
  AS $$ SELECT public.brain_tsv(pg_catalog.replace(address, '/', ' ') || ' ' || title || ' ' || summary || ' ' || body || ' ' || coalesce(pg_catalog.array_to_string(tags, ' '), '')) $$;

CREATE OR REPLACE FUNCTION public.brain_query(any_words text[], phrases text[], excluded text[]) RETURNS tsquery
  LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE
AS $$
DECLARE
  cfg regconfig;
  per tsquery;
  part tsquery;
  w text;
  result tsquery := NULL;
BEGIN
  FOREACH cfg IN ARRAY ARRAY['pg_catalog.simple', 'pg_catalog.spanish', 'pg_catalog.english']::regconfig[] LOOP
    per := NULL;
    IF coalesce(array_length(any_words, 1), 0) > 0 THEN
      part := NULL;
      FOREACH w IN ARRAY any_words LOOP
        IF numnode(plainto_tsquery(cfg, public.brain_unaccent(w))) > 0 THEN
          part := CASE WHEN part IS NULL THEN plainto_tsquery(cfg, public.brain_unaccent(w))
                       ELSE part || plainto_tsquery(cfg, public.brain_unaccent(w)) END;
        END IF;
      END LOOP;
      per := part;
    END IF;
    IF coalesce(array_length(phrases, 1), 0) > 0 THEN
      FOREACH w IN ARRAY phrases LOOP
        IF numnode(phraseto_tsquery(cfg, public.brain_unaccent(w))) > 0 THEN
          per := CASE WHEN per IS NULL THEN phraseto_tsquery(cfg, public.brain_unaccent(w))
                      ELSE per && phraseto_tsquery(cfg, public.brain_unaccent(w)) END;
        END IF;
      END LOOP;
    END IF;
    IF per IS NOT NULL AND coalesce(array_length(excluded, 1), 0) > 0 THEN
      FOREACH w IN ARRAY excluded LOOP
        IF numnode(plainto_tsquery(cfg, public.brain_unaccent(w))) > 0 THEN
          per := per && !! plainto_tsquery(cfg, public.brain_unaccent(w));
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
