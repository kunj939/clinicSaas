-- Outbox for WhatsApp messages, monthly quota counters, webhook de-duplication and bot conversation state.

CREATE TABLE outbound_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id uuid NOT NULL REFERENCES clinics (id) ON DELETE CASCADE,
  -- 'reply' = answer inside the patient's open conversation (no quota).
  -- 'notification' = business-initiated (counts against the monthly quota).
  kind text NOT NULL CHECK (kind IN ('reply', 'notification')),
  template_key text NOT NULL,
  to_phone_encrypted text NOT NULL,
  body_encrypted text NOT NULL,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'sent', 'failed')),
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_error text,
  provider text NOT NULL DEFAULT 'mock',
  provider_message_id text,
  dedupe_key text UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz
);
CREATE INDEX outbound_messages_queue_idx ON outbound_messages (status, next_attempt_at);
CREATE INDEX outbound_messages_clinic_idx ON outbound_messages (clinic_id, created_at DESC);

CREATE TABLE clinic_message_usage (
  clinic_id uuid NOT NULL REFERENCES clinics (id) ON DELETE CASCADE,
  period text NOT NULL CHECK (period ~ '^\d{4}-\d{2}$'),
  notifications_sent integer NOT NULL DEFAULT 0 CHECK (notifications_sent >= 0),
  PRIMARY KEY (clinic_id, period)
);

-- Each inbound provider message is processed once, even if the provider retries the webhook.
CREATE TABLE whatsapp_webhook_events (
  provider text NOT NULL,
  external_id text NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider, external_id)
);
CREATE INDEX whatsapp_webhook_events_received_idx ON whatsapp_webhook_events (received_at);

CREATE TABLE whatsapp_conversations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id uuid NOT NULL REFERENCES clinics (id) ON DELETE CASCADE,
  phone_hash text NOT NULL,
  phone_encrypted text NOT NULL,
  state text NOT NULL DEFAULT 'idle' CHECK (state IN ('idle', 'choose_doctor', 'await_name')),
  state_data jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (clinic_id, phone_hash)
);
