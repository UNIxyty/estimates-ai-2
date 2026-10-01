import type { Metadata } from 'next';
import { Suspense } from 'react';
import { SetPasswordForm } from './SetPasswordForm';

export const metadata: Metadata = { title: 'Set password · Estimates AI Agent' };

export default function SetPasswordPage() {
  return (
    <Suspense>
      <SetPasswordForm />
    </Suspense>
  );
}
