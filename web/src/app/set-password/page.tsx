import { Suspense } from 'react';
import { DesignPending } from '@/components/DesignPending';
import { SetPasswordForm } from './SetPasswordForm';

export default function SetPasswordPage() {
  return (
    <main>
      <DesignPending />
      <h1>Set your password</h1>
      <Suspense>
        <SetPasswordForm />
      </Suspense>
    </main>
  );
}
