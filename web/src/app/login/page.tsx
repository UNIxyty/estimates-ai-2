import type { Metadata } from 'next';
import { Suspense } from 'react';
import { LoginForms } from './LoginForms';

export const metadata: Metadata = { title: 'Sign in · MGS Estimates AI' };

export default function LoginPage() {
  return (
    <Suspense>
      <LoginForms />
    </Suspense>
  );
}
