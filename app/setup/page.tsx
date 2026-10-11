import { redirect } from 'next/navigation';
import { setupStatus } from '@/lib/auth/accounts';
import { SetupForm } from './setup-form';

export const dynamic = 'force-dynamic';

export default async function SetupPage() {
  const status = await setupStatus();
  if (status.configured) redirect('/login?role=admin');
  return <main className="flex min-h-screen items-center justify-center p-4"><SetupForm legacyRequired={status.legacyConfirmationRequired} canSetup={status.canSetup} /></main>;
}
