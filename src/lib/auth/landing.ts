import type { AccountRole } from '@/lib/auth/roles'

export function getLandingPath(role: AccountRole | null | undefined): string {
  return role === 'owner' ? '/owner-dashboard' : '/broadcasts'
}
