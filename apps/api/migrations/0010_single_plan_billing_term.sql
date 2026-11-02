-- One plan with everything included. The tiers are gone; a clinic now has a billing term instead.
-- The platform sets the term and the end date (there is no billing system yet).

ALTER TABLE clinics DROP COLUMN plan;

ALTER TABLE clinics
  ADD COLUMN billing_term text NOT NULL DEFAULT 'monthly' CHECK (billing_term IN ('monthly', 'six_months'));

ALTER TABLE clinics ADD COLUMN subscription_ends_at date;
