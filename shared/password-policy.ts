export const PASSWORD_MIN_LENGTH = 4;

export const PASSWORD_POLICY_MESSAGE = `Password must be at least ${PASSWORD_MIN_LENGTH} characters long.`;

export function validatePassword(password: unknown): boolean {
  return typeof password === 'string' && password.length >= PASSWORD_MIN_LENGTH;
}
