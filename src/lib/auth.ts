import { supabase } from './supabase'
import type { Profile, Role } from './types'

export async function signIn(email: string, password: string) {
  return supabase.auth.signInWithPassword({ email, password })
}

export async function signUp(email: string, password: string) {
  return supabase.auth.signUp({ email, password })
}

export async function signOut() {
  return supabase.auth.signOut()
}

export async function getCurrentUser() {
  const { data: { user } } = await supabase.auth.getUser()
  return user
}

export async function getProfile(): Promise<Profile | null> {
  const user = await getCurrentUser()
  if (!user) return null

  const { data, error } = await supabase
    .from('profiles')
    .select('*')
    .eq('id', user.id)
    .maybeSingle()

  if (error) return null
  return data as Profile
}

export function hasRole(profile: Profile | null, ...roles: Role[]): boolean {
  if (!profile) return false
  return roles.includes(profile.role)
}

export function isAdmin(profile: Profile | null): boolean {
  return hasRole(profile, 'owner', 'admin')
}

export function isOwner(profile: Profile | null): boolean {
  return hasRole(profile, 'owner')
}
