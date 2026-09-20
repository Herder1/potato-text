-- PostgreSQL draft schema. All public ids use UUIDs in production.

CREATE TABLE exam_projects (
  id UUID PRIMARY KEY,
  name TEXT NOT NULL,
  region TEXT NOT NULL,
  exam_type TEXT NOT NULL,
  exam_year INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE subjects (
  id UUID PRIMARY KEY,
  exam_project_id UUID NOT NULL REFERENCES exam_projects(id),
  name TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  UNIQUE (exam_project_id, name)
);

CREATE TABLE book_series (
  id UUID PRIMARY KEY,
  subject_id UUID NOT NULL REFERENCES subjects(id),
  name TEXT NOT NULL
);

CREATE TABLE books (
  id UUID PRIMARY KEY,
  subject_id UUID NOT NULL REFERENCES subjects(id),
  series_id UUID REFERENCES book_series(id),
  title TEXT NOT NULL,
  volume TEXT,
  authors TEXT,
  publisher TEXT,
  edition TEXT,
  published_year INTEGER,
  pdf_object_key TEXT,
  catalog_status TEXT NOT NULL DEFAULT 'awaiting_pdf',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE chapters (
  id UUID PRIMARY KEY,
  book_id UUID NOT NULL REFERENCES books(id),
  parent_id UUID REFERENCES chapters(id),
  title TEXT NOT NULL,
  start_page INTEGER,
  end_page INTEGER,
  sort_order INTEGER NOT NULL DEFAULT 0,
  review_status TEXT NOT NULL DEFAULT 'pending'
);

CREATE TABLE book_import_jobs (
  id UUID PRIMARY KEY,
  book_id UUID NOT NULL REFERENCES books(id),
  object_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'uploaded',
  page_count INTEGER,
  extraction_summary JSONB,
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ
);

CREATE TABLE textbook_chunks (
  id UUID PRIMARY KEY,
  book_id UUID NOT NULL REFERENCES books(id),
  chapter_id UUID REFERENCES chapters(id),
  start_page INTEGER NOT NULL,
  end_page INTEGER NOT NULL,
  content TEXT NOT NULL,
  embedding_ref TEXT,
  review_status TEXT NOT NULL DEFAULT 'pending',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE knowledge_points (
  id UUID PRIMARY KEY,
  chapter_id UUID NOT NULL REFERENCES chapters(id),
  parent_id UUID REFERENCES knowledge_points(id),
  name TEXT NOT NULL,
  description TEXT,
  review_status TEXT NOT NULL DEFAULT 'pending'
);

CREATE TABLE users (
  id UUID PRIMARY KEY,
  wechat_openid TEXT NOT NULL UNIQUE,
  unionid TEXT,
  community_name TEXT,
  avatar_url TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  training_consent BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE questions (
  id UUID PRIMARY KEY,
  owner_user_id UUID REFERENCES users(id),
  question_type TEXT NOT NULL,
  visibility TEXT NOT NULL DEFAULT 'private',
  moderation_status TEXT NOT NULL DEFAULT 'draft',
  current_version_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE question_versions (
  id UUID PRIMARY KEY,
  question_id UUID NOT NULL REFERENCES questions(id),
  version_number INTEGER NOT NULL,
  stem JSONB NOT NULL,
  options JSONB,
  standard_answer JSONB,
  max_score NUMERIC(8,2),
  change_summary TEXT,
  contributor_user_id UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (question_id, version_number)
);

ALTER TABLE questions
  ADD CONSTRAINT questions_current_version_fk
  FOREIGN KEY (current_version_id) REFERENCES question_versions(id);

CREATE TABLE question_knowledge_points (
  question_id UUID NOT NULL REFERENCES questions(id),
  knowledge_point_id UUID NOT NULL REFERENCES knowledge_points(id),
  is_primary BOOLEAN NOT NULL DEFAULT FALSE,
  PRIMARY KEY (question_id, knowledge_point_id)
);

CREATE TABLE scoring_points (
  id UUID PRIMARY KEY,
  question_version_id UUID NOT NULL REFERENCES question_versions(id),
  description TEXT NOT NULL,
  score NUMERIC(8,2) NOT NULL,
  evidence_hints JSONB,
  sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE answer_variants (
  id UUID PRIMARY KEY,
  question_id UUID NOT NULL REFERENCES questions(id),
  question_version_id UUID NOT NULL REFERENCES question_versions(id),
  author_user_id UUID REFERENCES users(id),
  answer_type TEXT NOT NULL,
  content JSONB NOT NULL,
  moderation_status TEXT NOT NULL DEFAULT 'pending',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE answer_votes (
  answer_variant_id UUID NOT NULL REFERENCES answer_variants(id),
  user_id UUID NOT NULL REFERENCES users(id),
  vote SMALLINT NOT NULL CHECK (vote IN (-1, 1)),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (answer_variant_id, user_id)
);

CREATE TABLE question_collections (
  id UUID PRIMARY KEY,
  exam_project_id UUID NOT NULL REFERENCES exam_projects(id),
  collection_type TEXT NOT NULL,
  name TEXT NOT NULL,
  is_paid BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE TABLE collection_questions (
  collection_id UUID NOT NULL REFERENCES question_collections(id),
  question_id UUID NOT NULL REFERENCES questions(id),
  sort_order INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (collection_id, question_id)
);

CREATE TABLE question_relations (
  source_question_id UUID NOT NULL REFERENCES questions(id),
  target_question_id UUID NOT NULL REFERENCES questions(id),
  relation_type TEXT NOT NULL,
  similarity_score NUMERIC(5,4),
  PRIMARY KEY (source_question_id, target_question_id, relation_type)
);

CREATE TABLE question_votes (
  question_id UUID NOT NULL REFERENCES questions(id),
  user_id UUID NOT NULL REFERENCES users(id),
  vote SMALLINT NOT NULL CHECK (vote IN (-1, 1)),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (question_id, user_id)
);

CREATE TABLE question_bookmarks (
  question_id UUID NOT NULL REFERENCES questions(id),
  user_id UUID NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (question_id, user_id)
);

CREATE TABLE comments (
  id UUID PRIMARY KEY,
  question_id UUID NOT NULL REFERENCES questions(id),
  user_id UUID NOT NULL REFERENCES users(id),
  parent_comment_id UUID REFERENCES comments(id),
  content TEXT NOT NULL,
  moderation_status TEXT NOT NULL DEFAULT 'visible',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ
);

CREATE TABLE correction_proposals (
  id UUID PRIMARY KEY,
  question_id UUID NOT NULL REFERENCES questions(id),
  base_version_id UUID NOT NULL REFERENCES question_versions(id),
  proposer_user_id UUID NOT NULL REFERENCES users(id),
  correction_type TEXT NOT NULL,
  proposed_changes JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  decided_by UUID REFERENCES users(id),
  decided_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE learning_sessions (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id),
  session_type TEXT NOT NULL,
  scope JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ
);

CREATE TABLE attempts (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id),
  question_id UUID NOT NULL REFERENCES questions(id),
  question_version_id UUID NOT NULL REFERENCES question_versions(id),
  learning_session_id UUID REFERENCES learning_sessions(id),
  session_type TEXT NOT NULL,
  submitted_answer JSONB,
  is_correct BOOLEAN,
  score NUMERIC(8,2),
  duration_ms INTEGER,
  mastery_self_rating TEXT,
  submitted_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE review_states (
  user_id UUID NOT NULL REFERENCES users(id),
  question_id UUID NOT NULL REFERENCES questions(id),
  stage INTEGER NOT NULL DEFAULT 0,
  mastery_status TEXT NOT NULL DEFAULT 'unknown',
  next_review_at TIMESTAMPTZ,
  last_review_at TIMESTAMPTZ,
  removed_manually BOOLEAN NOT NULL DEFAULT FALSE,
  PRIMARY KEY (user_id, question_id)
);

CREATE TABLE notes (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id),
  question_id UUID REFERENCES questions(id),
  title TEXT NOT NULL,
  content JSONB NOT NULL,
  visibility TEXT NOT NULL DEFAULT 'private',
  is_read_only BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE note_assets (
  id UUID PRIMARY KEY,
  note_id UUID NOT NULL REFERENCES notes(id),
  asset_type TEXT NOT NULL,
  object_key TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE question_packs (
  id UUID PRIMARY KEY,
  owner_user_id UUID NOT NULL REFERENCES users(id),
  exam_project_id UUID NOT NULL REFERENCES exam_projects(id),
  name TEXT NOT NULL,
  description TEXT,
  visibility TEXT NOT NULL DEFAULT 'private',
  moderation_status TEXT NOT NULL DEFAULT 'draft',
  source_pack_id UUID REFERENCES question_packs(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE question_pack_items (
  pack_id UUID NOT NULL REFERENCES question_packs(id),
  question_id UUID NOT NULL REFERENCES questions(id),
  sort_order INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (pack_id, question_id)
);

CREATE TABLE exam_papers (
  id UUID PRIMARY KEY,
  exam_project_id UUID NOT NULL REFERENCES exam_projects(id),
  owner_user_id UUID REFERENCES users(id),
  paper_type TEXT NOT NULL,
  title TEXT NOT NULL,
  source_label TEXT,
  duration_minutes INTEGER NOT NULL,
  total_score NUMERIC(8,2) NOT NULL,
  visibility TEXT NOT NULL DEFAULT 'private',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE exam_paper_items (
  exam_paper_id UUID NOT NULL REFERENCES exam_papers(id),
  question_id UUID NOT NULL REFERENCES questions(id),
  question_version_id UUID NOT NULL REFERENCES question_versions(id),
  score NUMERIC(8,2) NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (exam_paper_id, question_id)
);

CREATE TABLE exam_sessions (
  id UUID PRIMARY KEY,
  exam_paper_id UUID NOT NULL REFERENCES exam_papers(id),
  user_id UUID NOT NULL REFERENCES users(id),
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deadline_at TIMESTAMPTZ NOT NULL,
  submitted_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'active',
  objective_score NUMERIC(8,2),
  subjective_score NUMERIC(8,2),
  report JSONB
);

CREATE TABLE products (
  id UUID PRIMARY KEY,
  exam_project_id UUID NOT NULL REFERENCES exam_projects(id),
  subject_id UUID REFERENCES subjects(id),
  name TEXT NOT NULL,
  product_type TEXT NOT NULL,
  duration_days INTEGER NOT NULL DEFAULT 365,
  price_cents INTEGER NOT NULL,
  bonus_ai_credits INTEGER NOT NULL DEFAULT 0,
  active BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE TABLE entitlements (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id),
  product_id UUID NOT NULL REFERENCES products(id),
  starts_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  source TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE ai_credit_lots (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id),
  source TEXT NOT NULL,
  granted_amount INTEGER NOT NULL,
  remaining_amount INTEGER NOT NULL,
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE ai_credit_transactions (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id),
  credit_lot_id UUID REFERENCES ai_credit_lots(id),
  ai_call_id UUID,
  transaction_type TEXT NOT NULL,
  amount INTEGER NOT NULL,
  balance_after INTEGER NOT NULL,
  description TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE ai_providers (
  id UUID PRIMARY KEY,
  name TEXT NOT NULL,
  provider_type TEXT NOT NULL,
  encrypted_api_key TEXT NOT NULL,
  base_url TEXT,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE ai_models (
  id UUID PRIMARY KEY,
  provider_id UUID NOT NULL REFERENCES ai_providers(id),
  model_key TEXT NOT NULL,
  display_name TEXT NOT NULL,
  capabilities JSONB NOT NULL,
  pricing JSONB,
  enabled BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE TABLE prompt_versions (
  id UUID PRIMARY KEY,
  scene TEXT NOT NULL,
  version TEXT NOT NULL,
  system_prompt TEXT NOT NULL,
  output_schema JSONB,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (scene, version)
);

CREATE TABLE ai_routes (
  id UUID PRIMARY KEY,
  scene TEXT NOT NULL UNIQUE,
  primary_model_id UUID REFERENCES ai_models(id),
  fallback_model_id UUID REFERENCES ai_models(id),
  prompt_version_id UUID REFERENCES prompt_versions(id),
  timeout_ms INTEGER NOT NULL DEFAULT 30000,
  max_retries INTEGER NOT NULL DEFAULT 1,
  daily_cost_limit_micros BIGINT,
  credit_cost INTEGER NOT NULL DEFAULT 0,
  enabled BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE TABLE ai_calls (
  id UUID PRIMARY KEY,
  user_id UUID REFERENCES users(id),
  scene TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  status TEXT NOT NULL,
  latency_ms INTEGER,
  cost_micros BIGINT,
  charged_credits INTEGER NOT NULL DEFAULT 0,
  user_feedback SMALLINT,
  training_eligible BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE ai_credit_transactions
  ADD CONSTRAINT ai_credit_transactions_call_fk
  FOREIGN KEY (ai_call_id) REFERENCES ai_calls(id);

CREATE TABLE moderation_reports (
  id UUID PRIMARY KEY,
  reporter_user_id UUID NOT NULL REFERENCES users(id),
  target_type TEXT NOT NULL,
  target_id UUID NOT NULL,
  reason TEXT NOT NULL,
  details TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE audit_logs (
  id UUID PRIMARY KEY,
  actor_user_id UUID REFERENCES users(id),
  action TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id UUID,
  metadata JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE user_restrictions (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id),
  restriction_type TEXT NOT NULL,
  reason TEXT NOT NULL,
  starts_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ,
  created_by UUID REFERENCES users(id),
  lifted_at TIMESTAMPTZ,
  lifted_by UUID REFERENCES users(id)
);

CREATE TABLE notification_preferences (
  user_id UUID NOT NULL REFERENCES users(id),
  notification_type TEXT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  reminder_time TIME,
  wechat_template_id TEXT,
  PRIMARY KEY (user_id, notification_type)
);
