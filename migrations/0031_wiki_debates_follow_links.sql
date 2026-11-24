-- A known debate lasts only as long as the contradicts link between its two pages: when the last such link between
-- them goes (an unlink, a body or edit that drops it, a merge, a retired or deleted page), the mark goes too, so it
-- never hides a real contradiction written later. Done in the database, so every path that removes a link does it.
CREATE FUNCTION public.brain_debates_on_unlink() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM public.wiki_debates d
   WHERE d.brain_id = OLD.brain_id
     AND d.page_a = least(OLD.from_page, OLD.to_page)
     AND d.page_b = greatest(OLD.from_page, OLD.to_page)
     AND NOT EXISTS (SELECT 1 FROM public.page_links l
                      WHERE l.kind = 'contradicts'
                        AND ((l.from_page = OLD.from_page AND l.to_page = OLD.to_page)
                          OR (l.from_page = OLD.to_page AND l.to_page = OLD.from_page)));
  RETURN NULL;
END $$;
CREATE TRIGGER page_links_debates AFTER DELETE ON page_links
  FOR EACH ROW WHEN (OLD.kind = 'contradicts' AND OLD.to_page IS NOT NULL)
  EXECUTE FUNCTION public.brain_debates_on_unlink();
