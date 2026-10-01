/** Shared by client and server: at least 10 characters and at least one digit. */
export const PASSWORD_MIN_LENGTH = 10;
export const PASSWORD_MAX_LENGTH = 256;

export function passwordProblem(pw: string): string | null {
  if (typeof pw !== 'string' || pw.length < PASSWORD_MIN_LENGTH) {
    return `Password must be at least ${PASSWORD_MIN_LENGTH} characters.`;
  }
  if (!/[0-9]/.test(pw)) return 'Password must contain at least one number.';
  if (pw.length > PASSWORD_MAX_LENGTH) return 'Password is too long.';
  return null;
}

/** The live checklist on /set-password. Every item mirrors a rule in passwordProblem (plus "match"). */
export function passwordChecklist(pw: string, repeat: string): { label: string; ok: boolean }[] {
  return [
    { label: `At least ${PASSWORD_MIN_LENGTH} characters`, ok: pw.length >= PASSWORD_MIN_LENGTH },
    { label: 'Contains a number', ok: /[0-9]/.test(pw) },
    { label: 'Both passwords match', ok: pw.length > 0 && pw === repeat },
  ];
}
