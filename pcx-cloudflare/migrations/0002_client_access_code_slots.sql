-- Three fixed client access-code slots. Existing access codes remain valid
-- until all three new slots have been provisioned.
ALTER TABLE access_codes ADD COLUMN slot INTEGER;
ALTER TABLE access_codes ADD COLUMN code_ciphertext TEXT;
ALTER TABLE access_codes ADD COLUMN code_iv TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_access_codes_active_slot
  ON access_codes(slot) WHERE slot IS NOT NULL AND active=1;
