-- Usability of «Review later» (spec learning-memory A2, CA-A25): an undone change links the correction its comment
-- became, so a curator finds it from the change. Cleared with the comment when the proposal is purged.
ALTER TABLE wiki_changes ADD COLUMN correction_id text;
