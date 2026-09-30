import { hash, verify, type Options } from '@node-rs/argon2';

/**
 * Argon2id with OWASP parameters. Output is a standard PHC string
 * ($argon2id$v=19$m=19456,t=2,p=1$salt$hash) so Python argon2-cffi (worker seed script) can verify
 * hashes made here and vice versa.
 */
const ARGON2ID = 2 as Options['algorithm']; // Algorithm.Argon2id (const enum; not importable under isolatedModules)
export const ARGON2_OPTIONS: Options = { algorithm: ARGON2ID, memoryCost: 19456, timeCost: 2, parallelism: 1, outputLen: 32 };

export async function hashPassword(password: string): Promise<string> {
  return hash(password, ARGON2_OPTIONS);
}

export async function verifyPassword(phc: string | null | undefined, password: string): Promise<boolean> {
  if (!phc) return false;
  try {
    return await verify(phc, password);
  } catch {
    return false;
  }
}

let dummyHash: Promise<string> | null = null;
/** Verify against a throwaway hash so a missing user costs the same time as a wrong password. */
export async function burnVerify(password: string): Promise<void> {
  if (!dummyHash) dummyHash = hashPassword('dummy-password-for-timing-0');
  await verifyPassword(await dummyHash, password);
}

/** Password rules (mirrored client-side in src/lib/passwordRules.ts). */
export { passwordProblem } from '../passwordRules';
