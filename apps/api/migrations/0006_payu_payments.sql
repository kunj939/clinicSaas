-- Online payments through PayU hosted checkout.

-- A visit can now be paid online as well as by cash, UPI, card or other.
ALTER TABLE visits DROP CONSTRAINT visits_payment_method_check;
ALTER TABLE visits ADD CONSTRAINT visits_payment_method_check CHECK (payment_method IN ('cash', 'upi', 'card', 'other', 'online'));

-- One row per payment link. The link carries a random secret; only its SHA-256 hash is stored.
-- status moves pending -> paid or failed, once. The PayU callback can arrive more than once,
-- so only a pending row ever adds money to the visit.
CREATE TABLE payment_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id uuid NOT NULL REFERENCES clinics (id) ON DELETE CASCADE,
  visit_id uuid NOT NULL REFERENCES visits (id) ON DELETE CASCADE,
  txnid text NOT NULL UNIQUE,
  amount integer NOT NULL CHECK (amount > 0),
  token_hash text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'paid', 'failed')),
  gateway_payment_id text,
  created_by_user_id uuid REFERENCES users (id) ON DELETE SET NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  paid_at timestamptz
);
CREATE INDEX payment_requests_visit_idx ON payment_requests (visit_id);
