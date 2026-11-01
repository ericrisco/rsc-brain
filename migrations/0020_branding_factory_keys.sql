-- B6 PR25b (plan §4, G3, G4): the logo of the installation (bytes, the type read from them, their sha256
-- and when it changed), the address of RSC Factory, and the key of a meaning provider set from the web
-- (sealed with the installation secret, like the mail password; its last 4 characters to name it).
ALTER TABLE installation
  ADD COLUMN logo bytea,
  ADD COLUMN logo_type text,
  ADD COLUMN logo_sha256 text,
  ADD COLUMN logo_updated_at timestamptz,
  ADD COLUMN factory_url text;
ALTER TABLE meaning_settings
  ADD COLUMN openai_key text,
  ADD COLUMN openai_key_last4 text,
  ADD COLUMN ollama_url text;
