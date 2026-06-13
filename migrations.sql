-- ==========================================================================
-- Cricket App schema migrations
-- Run this in Supabase -> SQL Editor (safe to run more than once).
-- ==========================================================================

-- Standings columns on teams ------------------------------------------------
ALTER TABLE teams ADD COLUMN IF NOT EXISTS played int NOT NULL DEFAULT 0;
ALTER TABLE teams ADD COLUMN IF NOT EXISTS won    int NOT NULL DEFAULT 0;
ALTER TABLE teams ADD COLUMN IF NOT EXISTS lost   int NOT NULL DEFAULT 0;
ALTER TABLE teams ADD COLUMN IF NOT EXISTS tied   int NOT NULL DEFAULT 0;
ALTER TABLE teams ADD COLUMN IF NOT EXISTS points int NOT NULL DEFAULT 0;

-- Completed-match history ----------------------------------------------------
CREATE TABLE IF NOT EXISTS match_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  team_a_id uuid,
  team_b_id uuid,
  team_a_name text NOT NULL,
  team_b_name text NOT NULL,
  team_a_runs int,
  team_a_wickets int,
  team_a_overs text,
  team_b_runs int,
  team_b_wickets int,
  team_b_overs text,
  winner_id uuid,
  winner_name text,
  result_text text,
  total_overs int,
  state jsonb,
  created_at timestamptz DEFAULT now()
);
