-- Nine languages for the app and the patient messages, and a clinic setting for how far ahead patients can book.

ALTER TABLE clinics DROP CONSTRAINT clinics_default_language_check;
ALTER TABLE clinics ADD CONSTRAINT clinics_default_language_check
  CHECK (default_language IN ('en', 'hi', 'mr', 'gu', 'bn', 'ta', 'te', 'kn', 'pa'));

ALTER TABLE patients DROP CONSTRAINT patients_preferred_language_check;
ALTER TABLE patients ADD CONSTRAINT patients_preferred_language_check
  CHECK (preferred_language IN ('en', 'hi', 'mr', 'gu', 'bn', 'ta', 'te', 'kn', 'pa'));

-- The WhatsApp conversation gains a language step and a day-choice step.
ALTER TABLE whatsapp_conversations DROP CONSTRAINT whatsapp_conversations_state_check;
ALTER TABLE whatsapp_conversations ADD CONSTRAINT whatsapp_conversations_state_check
  CHECK (state IN ('idle', 'await_language', 'await_name', 'await_age', 'await_phone', 'choose_day', 'choose_doctor'));

-- How many days ahead patients may book on WhatsApp. 1 means tomorrow only.
ALTER TABLE clinics
  ADD COLUMN booking_window_days integer NOT NULL DEFAULT 1 CHECK (booking_window_days BETWEEN 1 AND 7);
