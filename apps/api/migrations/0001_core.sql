-- Core tenancy, identity, doctors, schedules, holidays, patients and audit trail.
-- Every tenant-owned table carries clinic_id; services always filter by it.

CREATE TABLE clinics (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (char_length(name) BETWEEN 2 AND 160),
  slug text NOT NULL UNIQUE,
  address text,
  contact_phone text,
  timezone text NOT NULL DEFAULT 'Asia/Kolkata',
  default_language text NOT NULL DEFAULT 'en' CHECK (default_language IN ('en', 'hi')),
  booking_cutoff_time time NOT NULL DEFAULT '20:00',
  monthly_message_quota integer NOT NULL DEFAULT 300 CHECK (monthly_message_quota >= 0),
  -- Meta WhatsApp phone_number_id; inbound webhooks are routed to the clinic with this value.
  whatsapp_phone_number_id text UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE doctors (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id uuid NOT NULL REFERENCES clinics (id) ON DELETE CASCADE,
  name text NOT NULL CHECK (char_length(name) BETWEEN 2 AND 160),
  specialization text,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX doctors_clinic_idx ON doctors (clinic_id);

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id uuid REFERENCES clinics (id) ON DELETE CASCADE,
  doctor_id uuid REFERENCES doctors (id) ON DELETE SET NULL,
  email text NOT NULL UNIQUE CHECK (email = lower(email)),
  password_hash text NOT NULL,
  full_name text NOT NULL,
  role text NOT NULL CHECK (role IN ('owner', 'receptionist', 'doctor')),
  is_active boolean NOT NULL DEFAULT true,
  failed_login_count integer NOT NULL DEFAULT 0,
  locked_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT users_doctor_role_has_doctor CHECK (role <> 'doctor' OR doctor_id IS NOT NULL),
  CONSTRAINT users_staff_has_clinic CHECK (role = 'owner' OR clinic_id IS NOT NULL)
);
CREATE INDEX users_clinic_idx ON users (clinic_id);

CREATE TABLE sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  -- Only the SHA-256 of the cookie secret is stored.
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sessions_user_idx ON sessions (user_id);

CREATE TABLE doctor_schedules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id uuid NOT NULL REFERENCES clinics (id) ON DELETE CASCADE,
  doctor_id uuid NOT NULL REFERENCES doctors (id) ON DELETE CASCADE,
  weekday smallint NOT NULL CHECK (weekday BETWEEN 0 AND 6),
  start_time time NOT NULL,
  end_time time NOT NULL,
  max_tokens integer NOT NULL CHECK (max_tokens BETWEEN 1 AND 500),
  is_active boolean NOT NULL DEFAULT true,
  UNIQUE (doctor_id, weekday),
  CHECK (end_time > start_time)
);

CREATE TABLE clinic_holidays (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id uuid NOT NULL REFERENCES clinics (id) ON DELETE CASCADE,
  holiday_date date NOT NULL,
  reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (clinic_id, holiday_date)
);

CREATE TABLE patients (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id uuid NOT NULL REFERENCES clinics (id) ON DELETE CASCADE,
  full_name text NOT NULL CHECK (char_length(full_name) BETWEEN 1 AND 160),
  -- Phone is optional (walk-ins). Stored encrypted; the blind index allows lookup by number.
  phone_hash text,
  phone_encrypted text,
  gender text CHECK (gender IN ('male', 'female', 'other')),
  age_years smallint CHECK (age_years BETWEEN 0 AND 130),
  preferred_language text NOT NULL DEFAULT 'en' CHECK (preferred_language IN ('en', 'hi')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (clinic_id, phone_hash),
  CHECK ((phone_hash IS NULL) = (phone_encrypted IS NULL))
);
CREATE INDEX patients_clinic_name_idx ON patients (clinic_id, lower(full_name));

-- Append-only. Metadata must never contain patient names, phone numbers or clinical text.
CREATE TABLE audit_logs (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  clinic_id uuid REFERENCES clinics (id) ON DELETE CASCADE,
  actor_user_id uuid REFERENCES users (id) ON DELETE SET NULL,
  action text NOT NULL,
  entity_type text NOT NULL,
  entity_id text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_logs_clinic_idx ON audit_logs (clinic_id, id DESC);
