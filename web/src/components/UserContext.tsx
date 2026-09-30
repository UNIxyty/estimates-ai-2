'use client';

import { createContext, useContext } from 'react';

export interface ClientUser {
  id: string;
  email: string;
  name: string;
  role: 'estimator' | 'admin';
}

const Ctx = createContext<ClientUser | null>(null);

export function UserProvider({ user, children }: { user: ClientUser; children: React.ReactNode }) {
  return <Ctx.Provider value={user}>{children}</Ctx.Provider>;
}

export function useUser(): ClientUser {
  const u = useContext(Ctx);
  if (!u) throw new Error('useUser outside UserProvider');
  return u;
}
