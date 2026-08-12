CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS catalog_creatures (
  id text PRIMARY KEY CHECK (id ~ '^PG-[0-9]{3}$'),
  ko_name text NOT NULL,
  en_name text NOT NULL,
  lineage_id text NOT NULL,
  category text NOT NULL CHECK (category IN ('start','normal_evolution','branch','mixed','special','mutant')),
  stage smallint NOT NULL CHECK (stage BETWEEN 1 AND 4),
  rarity text NOT NULL CHECK (rarity IN ('PROCESS','AGENT','DAEMON','ORACLE','ARCHITECT','ORIGIN')),
  body_form text NOT NULL,
  tone text NOT NULL,
  identity_text text NOT NULL,
  lore text NOT NULL,
  shape_dna jsonb NOT NULL,
  palette jsonb NOT NULL,
  shared_motifs jsonb NOT NULL,
  evolution_from jsonb,
  image_path text NOT NULL
);

CREATE TABLE IF NOT EXISTS players (
  id uuid PRIMARY KEY,
  token_balance bigint NOT NULL DEFAULT 3000000 CHECK (token_balance >= 0),
  total_usage bigint NOT NULL DEFAULT 0 CHECK (total_usage >= 0),
  pity_count integer NOT NULL DEFAULT 0 CHECK (pity_count BETWEEN 0 AND 300),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS token_ingestions (
  id bigserial PRIMARY KEY,
  player_id uuid NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  event_id uuid NOT NULL,
  source text NOT NULL CHECK (source IN ('claude_code','codex')),
  occurred_at timestamptz NOT NULL,
  input_tokens bigint NOT NULL CHECK (input_tokens BETWEEN 0 AND 1000000000),
  output_tokens bigint NOT NULL CHECK (output_tokens BETWEEN 0 AND 1000000000),
  cache_read_tokens bigint NOT NULL CHECK (cache_read_tokens BETWEEN 0 AND 1000000000),
  cache_write_tokens bigint NOT NULL CHECK (cache_write_tokens BETWEEN 0 AND 1000000000),
  total_tokens bigint GENERATED ALWAYS AS (input_tokens + output_tokens + cache_read_tokens + cache_write_tokens) STORED,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (player_id, event_id)
);

CREATE INDEX IF NOT EXISTS token_ingestions_player_week_idx ON token_ingestions(player_id, occurred_at DESC);

CREATE TABLE IF NOT EXISTS creature_instances (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  player_id uuid NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  catalog_id text NOT NULL REFERENCES catalog_creatures(id),
  level integer NOT NULL DEFAULT 1 CHECK (level BETWEEN 1 AND 100),
  experience bigint NOT NULL DEFAULT 0 CHECK (experience >= 0),
  affection integer NOT NULL DEFAULT 0 CHECK (affection BETWEEN 0 AND 100),
  unique_color boolean NOT NULL DEFAULT false,
  personality text NOT NULL CHECK (personality IN ('curious','brave','calm','playful','focused')),
  str_aptitude smallint NOT NULL CHECK (str_aptitude BETWEEN 1 AND 10),
  agi_aptitude smallint NOT NULL CHECK (agi_aptitude BETWEEN 1 AND 10),
  wit_aptitude smallint NOT NULL CHECK (wit_aptitude BETWEEN 1 AND 10),
  acquired_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS creature_instances_player_idx ON creature_instances(player_id, acquired_at DESC);

CREATE TABLE IF NOT EXISTS item_inventory (
  player_id uuid NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  item_type text NOT NULL CHECK (item_type IN ('food','training_tool','evolution_material','care_item','skill_book','hatch_accelerator','expedition_ticket','decoration','healing_potion')),
  quantity integer NOT NULL DEFAULT 0 CHECK (quantity BETWEEN 0 AND 1000000),
  PRIMARY KEY (player_id, item_type)
);

CREATE TABLE IF NOT EXISTS gacha_requests (
  player_id uuid NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  request_id uuid NOT NULL,
  creature_instance_id uuid NOT NULL REFERENCES creature_instances(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (player_id, request_id)
);
