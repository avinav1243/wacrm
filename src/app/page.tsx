import { redirect } from 'next/navigation'

import { createClient } from '@/lib/supabase/server'
import { getLandingPath } from '@/lib/auth/landing'

export default async function RootPage() {
  const supabase = await createClient()
  const {
    data: { session },
  } = await supabase.auth.getSession()

  if (!session?.user) {
    redirect('/login')
  }

  const { data: profile } = await supabase
    .from('profiles')
    .select('account_role')
    .eq('user_id', session.user.id)
    .maybeSingle()

  redirect(getLandingPath(profile?.account_role as 'owner' | 'admin' | 'agent' | 'viewer' | null))
}
