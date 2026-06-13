import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';

dotenv.config();

const supabaseUrl = process.env.SUPABASE_URL;
// Prefer the service_role key (bypasses Row-Level Security) for this trusted
// backend; fall back to the anon key so existing setups keep working.
const supabaseKey = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY;

if (!supabaseUrl || !supabaseKey) {
    throw new Error("Missing Supabase URL or Key in environment variables.");
}

export const supabase = createClient(supabaseUrl, supabaseKey);