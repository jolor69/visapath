CREATE TABLE IF NOT EXISTS rule_chunks (
  id TEXT PRIMARY KEY,
  country_code TEXT NOT NULL,
  source_url TEXT NOT NULL,
  source_tier TEXT NOT NULL CHECK (source_tier IN ('official', 'aggregator', 'placeholder')),
  chunk_text TEXT NOT NULL,
  chunk_hash TEXT NOT NULL,
  last_verified_date TEXT NOT NULL,
  vector_id TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_rule_chunks_country ON rule_chunks(country_code);

CREATE TABLE IF NOT EXISTS ingestion_log (
  run_id TEXT NOT NULL,
  started_at TEXT NOT NULL,
  country_code TEXT NOT NULL,
  source TEXT,
  source_tier TEXT,
  chunks_added INTEGER DEFAULT 0,
  chunks_updated INTEGER DEFAULT 0,
  tier_downgraded INTEGER DEFAULT 0,
  errors TEXT
);

CREATE INDEX IF NOT EXISTS idx_ingestion_log_run ON ingestion_log(run_id);

CREATE TABLE IF NOT EXISTS country_registry (
  country_code TEXT PRIMARY KEY,
  country_name TEXT NOT NULL,
  target_tier TEXT NOT NULL CHECK (target_tier IN ('official', 'aggregator')),
  is_placeholder_list INTEGER DEFAULT 1,
  official_source_url TEXT,
  aggregator_source_url TEXT,
  tos_review_status TEXT DEFAULT 'unreviewed'
);
