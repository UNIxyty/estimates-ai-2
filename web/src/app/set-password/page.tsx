import type { Metadata } from 'next';
import { Suspense } from 'react';
import { SetPasswordForm } from './SetPasswordForm';

export const metadata: Metadata = { title: 'Set password · MGS Estimates AI' };

export default function SetPasswordPage() {
  return (
    <Suspense>
      <SetPasswordForm />
    </Suspense>
  );
}
