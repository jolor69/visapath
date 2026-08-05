CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  plan TEXT NOT NULL DEFAULT 'free'
);

CREATE TABLE IF NOT EXISTS trips (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  title TEXT NOT NULL,
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  origin_country TEXT,
  destination_countries TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'needs_attention' CHECK (status IN ('ready', 'needs_attention', 'urgent_issue')),
  readiness_score INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_trips_user ON trips(user_id);

CREATE TABLE IF NOT EXISTS travelers (
  id TEXT PRIMARY KEY,
  trip_id TEXT NOT NULL REFERENCES trips(id),
  full_name TEXT NOT NULL,
  dob TEXT,
  nationality TEXT,
  relationship TEXT,
  status TEXT NOT NULL DEFAULT 'needs_attention' CHECK (status IN ('ready', 'needs_attention', 'urgent_issue')),
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_travelers_trip ON travelers(trip_id);

CREATE TABLE IF NOT EXISTS documents (
  id TEXT PRIMARY KEY,
  trip_id TEXT NOT NULL REFERENCES trips(id),
  traveler_id TEXT REFERENCES travelers(id),
  document_type TEXT NOT NULL CHECK (document_type IN ('passport', 'visa', 'health_cert', 'id_card', 'unknown')),
  type_confidence REAL,
  r2_key TEXT NOT NULL,
  quality_status TEXT NOT NULL DEFAULT 'pending' CHECK (quality_status IN ('pending', 'ok', 'blurry', 'glare', 'cropped', 'low_res', 'unreadable')),
  extraction_status TEXT NOT NULL DEFAULT 'processing' CHECK (extraction_status IN ('processing', 'extracted', 'failed', 'needs_review')),
  extraction_model TEXT,
  uploaded_at TEXT NOT NULL,
  delete_after TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_documents_trip ON documents(trip_id);
CREATE INDEX IF NOT EXISTS idx_documents_delete_after ON documents(delete_after);

CREATE TABLE IF NOT EXISTS extracted_fields (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES documents(id),
  field_name TEXT NOT NULL,
  field_value TEXT,
  normalized_value TEXT,
  confidence REAL,
  edited_value TEXT,
  edited_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_fields_document ON extracted_fields(document_id);

CREATE TABLE IF NOT EXISTS validation_issues (
  id TEXT PRIMARY KEY,
  trip_id TEXT NOT NULL REFERENCES trips(id),
  traveler_id TEXT REFERENCES travelers(id),
  severity TEXT NOT NULL CHECK (severity IN ('info', 'warning', 'critical')),
  issue_type TEXT NOT NULL,
  description TEXT NOT NULL,
  action_required TEXT NOT NULL,
  due_date TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'reviewed', 'resolved')),
  reviewer_note TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_issues_trip ON validation_issues(trip_id);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  expires_at TEXT NOT NULL
);
