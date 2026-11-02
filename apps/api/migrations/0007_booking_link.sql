-- Click-to-chat booking: the bot now collects age and confirms the number before issuing a token.

ALTER TABLE whatsapp_conversations DROP CONSTRAINT whatsapp_conversations_state_check;
ALTER TABLE whatsapp_conversations ADD CONSTRAINT whatsapp_conversations_state_check
  CHECK (state IN ('idle', 'choose_doctor', 'await_name', 'await_age', 'await_phone'));

-- The number patients message, in international form (for example +919876543210). Used to build the wa.me booking link.
ALTER TABLE clinics
  ADD COLUMN whatsapp_display_number text CHECK (whatsapp_display_number IS NULL OR whatsapp_display_number ~ '^\+[1-9][0-9]{7,14}$');
