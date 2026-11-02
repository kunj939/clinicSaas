-- Serial token queue. A day row per doctor and date holds the capacity and the counters
-- that are advanced with single atomic UPDATE statements, so tokens can never oversell.

CREATE TABLE appointment_days (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id uuid NOT NULL REFERENCES clinics (id) ON DELETE CASCADE,
  doctor_id uuid NOT NULL REFERENCES doctors (id) ON DELETE CASCADE,
  service_date date NOT NULL,
  capacity integer NOT NULL CHECK (capacity > 0),
  -- Last token number handed out. Numbers are never reused, even after cancellations.
  last_token_number integer NOT NULL DEFAULT 0 CHECK (last_token_number >= 0),
  -- Tokens currently occupying capacity (cancelled tokens release their slot).
  active_count integer NOT NULL DEFAULT 0 CHECK (active_count >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (doctor_id, service_date),
  CHECK (active_count <= capacity)
);
CREATE INDEX appointment_days_clinic_date_idx ON appointment_days (clinic_id, service_date);

CREATE TABLE tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id uuid NOT NULL REFERENCES clinics (id) ON DELETE CASCADE,
  day_id uuid NOT NULL REFERENCES appointment_days (id) ON DELETE CASCADE,
  doctor_id uuid NOT NULL REFERENCES doctors (id) ON DELETE CASCADE,
  patient_id uuid NOT NULL REFERENCES patients (id) ON DELETE RESTRICT,
  service_date date NOT NULL,
  token_number integer NOT NULL CHECK (token_number > 0),
  source text NOT NULL CHECK (source IN ('whatsapp', 'phone', 'walk_in')),
  status text NOT NULL DEFAULT 'booked' CHECK (
    status IN ('booked', 'checked_in', 'in_consultation', 'completed', 'no_show', 'cancelled')
  ),
  checked_in_at timestamptz,
  called_at timestamptz,
  completed_at timestamptz,
  cancelled_at timestamptz,
  created_by_user_id uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (day_id, token_number)
);
-- A patient holds only one live token per doctor per day (guards double taps and webhook replays).
CREATE UNIQUE INDEX tokens_one_live_per_patient ON tokens (day_id, patient_id) WHERE status <> 'cancelled';
-- At most one patient in consultation per doctor per day.
CREATE UNIQUE INDEX tokens_one_in_consultation ON tokens (day_id) WHERE status = 'in_consultation';
CREATE INDEX tokens_queue_idx ON tokens (day_id, status, token_number);
CREATE INDEX tokens_patient_idx ON tokens (clinic_id, patient_id, service_date DESC);

CREATE TABLE visits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id uuid NOT NULL REFERENCES clinics (id) ON DELETE CASCADE,
  token_id uuid NOT NULL UNIQUE REFERENCES tokens (id) ON DELETE CASCADE,
  patient_id uuid NOT NULL REFERENCES patients (id) ON DELETE RESTRICT,
  doctor_id uuid NOT NULL REFERENCES doctors (id) ON DELETE CASCADE,
  visit_date date NOT NULL,
  diagnosis text,
  clinical_notes text,
  prescription text,
  follow_up_date date,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX visits_patient_idx ON visits (clinic_id, patient_id, visit_date DESC);

CREATE TABLE follow_ups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id uuid NOT NULL REFERENCES clinics (id) ON DELETE CASCADE,
  patient_id uuid NOT NULL REFERENCES patients (id) ON DELETE CASCADE,
  doctor_id uuid NOT NULL REFERENCES doctors (id) ON DELETE CASCADE,
  visit_id uuid REFERENCES visits (id) ON DELETE SET NULL,
  due_date date NOT NULL,
  reason text,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'done', 'cancelled')),
  last_reminder_at timestamptz,
  created_by_user_id uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);
CREATE INDEX follow_ups_due_idx ON follow_ups (clinic_id, status, due_date);
