ALTER TABLE learner_profiles ADD COLUMN account_kind TEXT
  CHECK (account_kind IS NULL OR account_kind IN ('individual', 'student', 'teacher'));
