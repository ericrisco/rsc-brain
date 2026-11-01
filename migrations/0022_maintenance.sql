-- Spec B7 «Actualizar» (C12): while an update or a restore runs, rsc-brain refuses writes until this moment,
-- and says why. Past it, the maintenance has ended on its own (at most 30 minutes after it was set).
ALTER TABLE installation
  ADD COLUMN maintenance_until timestamptz,
  ADD COLUMN maintenance_reason text CHECK (maintenance_reason IN ('update', 'restore', 'manual'));
