-- Report files are stored in the database (small PDFs and images), so they survive
-- restarts on managed Node hosting that has an ephemeral disk.

CREATE TABLE reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id uuid NOT NULL REFERENCES clinics (id) ON DELETE CASCADE,
  visit_id uuid NOT NULL REFERENCES visits (id) ON DELETE CASCADE,
  patient_id uuid NOT NULL REFERENCES patients (id) ON DELETE RESTRICT,
  doctor_id uuid NOT NULL REFERENCES doctors (id) ON DELETE CASCADE,
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 160),
  mime_type text NOT NULL CHECK (mime_type IN ('application/pdf', 'image/jpeg', 'image/png')),
  size_bytes integer NOT NULL CHECK (size_bytes > 0),
  sha256 text NOT NULL,
  content bytea NOT NULL,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'ready')),
  ready_at timestamptz,
  uploaded_by_user_id uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX reports_patient_idx ON reports (clinic_id, patient_id, created_at DESC);

-- Bearer links sent to patients. Only a hash of the secret is stored; links expire and have a use limit.
CREATE TABLE report_access_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id uuid NOT NULL REFERENCES clinics (id) ON DELETE CASCADE,
  report_id uuid NOT NULL REFERENCES reports (id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  max_uses integer NOT NULL CHECK (max_uses > 0),
  use_count integer NOT NULL DEFAULT 0 CHECK (use_count >= 0),
  revoked_at timestamptz,
  created_by_user_id uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX report_access_links_report_idx ON report_access_links (report_id);
