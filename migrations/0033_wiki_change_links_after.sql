-- Review round 2 of «Review later» (spec learning-memory A2, CA-A10): an undo takes back exactly what the change did to the
-- links into each of its pages, so the parts keep those links as the change left them too. NULL for a change recorded
-- before this column: its undo leaves the links into the page as they are.
ALTER TABLE wiki_change_parts ADD COLUMN links_in_after jsonb;
