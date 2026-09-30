/** Shared by client and server: at least 10 characters and at least one digit. */
export const PASSWORD_MIN_LENGTH = 10;

export function passwordProblem(pw: string): string | null {
  if (typeof pw !== 'string' || pw.length < PASSWORD_MIN_LENGTH) {
    return `Password must be at least ${PASSWORD_MIN_LENGTH} characters.`;
  }
  if (!/[0-9]/.test(pw)) return 'Password must contain at least one number.';
  if (pw.length > 256) return 'Password is too long.';
  return null;
}
