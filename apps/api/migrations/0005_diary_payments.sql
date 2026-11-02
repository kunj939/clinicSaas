-- Medicine-based follow-ups, daily diary and payments.

-- How many days before the medicine runs out the patient is reminded (0 = on the last day).
ALTER TABLE clinics
  ADD COLUMN follow_up_lead_days integer NOT NULL DEFAULT 1 CHECK (follow_up_lead_days BETWEEN 0 AND 30);

-- Visit: how long the prescribed medicine lasts, and what was charged and paid.
-- Amounts are whole rupees.
ALTER TABLE visits
  ADD COLUMN medicine_days integer CHECK (medicine_days BETWEEN 1 AND 366),
  ADD COLUMN fee_amount integer CHECK (fee_amount BETWEEN 0 AND 10000000),
  ADD COLUMN amount_paid integer CHECK (amount_paid BETWEEN 0 AND 10000000),
  ADD COLUMN payment_method text CHECK (payment_method IN ('cash', 'upi', 'card', 'other'));

-- The hourly reminder job looks up open follow-ups by due date.
CREATE INDEX follow_ups_open_due_idx ON follow_ups (clinic_id, due_date) WHERE status = 'open';
