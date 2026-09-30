import { Suspense } from 'react';
import { DesignPending } from '@/components/DesignPending';
import { LoginForms } from './LoginForms';

export default function LoginPage() {
  return (
    <main>
      <DesignPending />
      <h1>Sign in</h1>
      <p>Estimates AI Agent is invite-only. Ask an admin for an invite if you do not have an account.</p>
      <Suspense>
        <LoginForms />
      </Suspense>
    </main>
  );
}
