-- Spec v0.6 «Búsqueda»: what BM25 ranks besides the title, as one text per row. An index expression must be
-- IMMUTABLE and array_to_string is only STABLE, hence these wrappers, with their schema named so a pg_dump copy
-- restores (CA16). The BM25 index itself is made only when pg_search is installed (src/db/extensions.ts).
CREATE FUNCTION public.brain_page_text(address text, summary text, body text, tags text[]) RETURNS text
  LANGUAGE sql IMMUTABLE PARALLEL SAFE
  AS $$ SELECT summary || ' ' || body || ' ' || pg_catalog.replace(address, '/', ' ') || ' ' || coalesce(pg_catalog.array_to_string(tags, ' '), '') $$;

CREATE FUNCTION public.brain_entry_text(topic text, content text, tags text[]) RETURNS text
  LANGUAGE sql IMMUTABLE PARALLEL SAFE
  AS $$ SELECT content || ' ' || coalesce(pg_catalog.replace(topic, '/', ' '), '') || ' ' || coalesce(pg_catalog.array_to_string(tags, ' '), '') $$;
