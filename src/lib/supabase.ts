import { createClient } from '@supabase/supabase-js'

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY

export const isSupabaseConfigured = Boolean(supabaseUrl && supabaseAnonKey)

if (!isSupabaseConfigured) {
  // Auth/dashboard sync is optional, not a boot-time requirement -- AI
  // itself never depends on Supabase (see local-runtime/browser tiers),
  // so a deployment with no Supabase project configured yet should still
  // load and let those tiers work, the same "degrade to a no-op, never
  // crash the bundle" contract platformApi.ts already documents for its
  // own optional dependency. createClient() itself makes no network call
  // at construction time -- only calls like .auth.getSession() would, and
  // those already resolve to "no session" locally when there is nothing
  // cached to refresh, rather than throwing.
  console.warn('Supabase environment variables are missing -- sign-in and cross-device sync are disabled, AI features are unaffected.')
}

export const supabase = createClient(supabaseUrl || 'https://unconfigured.invalid', supabaseAnonKey || 'unconfigured')
