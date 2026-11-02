-- Plans gate premium features. The platform sets a clinic's plan (there is no billing yet).
-- Each clinic chooses which languages its patients and staff see.

ALTER TABLE clinics
  ADD COLUMN plan text NOT NULL DEFAULT 'premium' CHECK (plan IN ('starter', 'premium'));

ALTER TABLE clinics
  ADD COLUMN enabled_languages text[] NOT NULL DEFAULT ARRAY['en', 'hi']::text[]
  CHECK (
    cardinality(enabled_languages) >= 1
    AND enabled_languages <@ ARRAY['en', 'hi', 'mr', 'gu', 'bn', 'ta', 'te', 'kn', 'pa']::text[]
  );
