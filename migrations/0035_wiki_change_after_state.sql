-- Undo by detection (spec learning-memory A2, CA-A10; replanteo after the closing review): each part keeps the state the
-- change left its page in, so an undo can tell whether anything changed since. If nothing did, the page goes back
-- exactly; if anything did, the undo is refused whole and says what. NULL for a part recorded before this column.
ALTER TABLE wiki_change_parts
  ADD COLUMN status_after text,
  ADD COLUMN superseded_by_after text,
  ADD COLUMN addresses_after jsonb,
  ADD COLUMN links_out_after jsonb;
