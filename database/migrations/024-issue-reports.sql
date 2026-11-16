-- 024: employee-reported issues for the PA system
-- Re-runnable: IF NOT EXISTS guards everywhere.

CREATE TABLE IF NOT EXISTS survey.issues (
  id           SERIAL PRIMARY KEY,
  title        TEXT NOT NULL,
  description  TEXT NOT NULL,
  steps        TEXT,
  severity     TEXT NOT NULL DEFAULT 'medium'
                 CHECK (severity IN ('low','medium','high','critical')),
  area         TEXT,
  user_agent   TEXT,
  status       TEXT NOT NULL DEFAULT 'open'
                 CHECK (status IN ('open','analyzing','reviewed','resolved')),
  submitted_by TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  analysis     JSONB,
  analyzed_at  TIMESTAMPTZ,
  resolution   TEXT
);

GRANT SELECT, INSERT, UPDATE ON survey.issues TO survey_app;
GRANT USAGE, SELECT ON SEQUENCE survey.issues_id_seq TO survey_app;
