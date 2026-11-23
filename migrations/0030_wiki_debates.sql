-- E2E findings (health): two pages that contradict each other on purpose (a known debate between two papers)
-- are not a problem to resolve. A curator marks the pair as a known debate; the pair then leaves the health
-- problems and the cleanup suggestion, and shows in a list of its own. Unmarking it is deleting the row. The pair
-- is kept by page, smaller id first, so moving a page keeps it.
CREATE TABLE wiki_debates (
  brain_id        text NOT NULL REFERENCES brains(id) ON DELETE CASCADE,
  page_a          text NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  page_b          text NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  acknowledged_by text NOT NULL REFERENCES accounts(id),
  acknowledged_at timestamptz NOT NULL,
  PRIMARY KEY (brain_id, page_a, page_b),
  CHECK (page_a < page_b)
);
