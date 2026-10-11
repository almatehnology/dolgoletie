import { Suspense } from 'react';
import { redirect } from 'next/navigation';
import { readAuth } from '@/lib/auth/store';
import { LoginForm } from './login-form';

export const dynamic = 'force-dynamic';

export default async function LoginPage() {
  if (!(await readAuth()).admin) redirect('/setup');
  return (
    <main className="flex min-h-screen items-center justify-center p-4">
      <Suspense fallback={null}>
        <LoginForm />
      </Suspense>
    </main>
  );
}
