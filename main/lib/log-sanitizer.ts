const JWT_TOKEN_RE = /\beyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g;

const AUTH_HEADER_RE = /(authorization\s*["']?\s*[:=]\s*["']?(?:bearer|basic)\s+)[^\s"',;}\]]+/gi;

const BEARER_TOKEN_RE = /\b(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi;

const GOOGLE_OAUTH_ACCESS_TOKEN_RE = /\bya29\.[A-Za-z0-9._-]+/g;
const GOOGLE_OAUTH_REFRESH_TOKEN_RE = /\b1\/\/[A-Za-z0-9._-]{10,}/g;

const SENSITIVE_KEY_PATTERN =
  'x-master-pin|master_pin|masterPin|new_password|current_password|password|new_pin|current_pin|pin|cloud_api_key|cloudApiKey|cloud_device_secret|cloudDeviceSecret|jwt_secret|jwtSecret|access_token|accessToken|refresh_token|refreshToken|id_token|idToken|client_secret|clientSecret|oauth_token|oauthToken|recovery_token|recoveryToken|pairing_token|pairingToken|display_token|displayToken';

const QUOTED_KEY_VALUE_RE = new RegExp(
  `(["']?(?:${SENSITIVE_KEY_PATTERN})["']?\\s*[:=]\\s*)(["'])(?:\\\\.|(?!\\2)[^\\\\])*\\2`,
  'gi',
);

const UNQUOTED_KEY_VALUE_RE = new RegExp(
  `(\\b(?:${SENSITIVE_KEY_PATTERN})\\b["']?\\s*[:=]\\s*)(?!["']|\\[REDACTED\\])([^\\s&"',;}\\]]+)`,
  'gi',
);

/** Redacts credentials, tokens, and secrets from diagnostic log tails while preserving stack traces and error codes. */
export function sanitizeLogTail(text: string): string {
  if (!text) return text;
  return text
    .replace(JWT_TOKEN_RE, '[REDACTED]')
    .replace(AUTH_HEADER_RE, '$1[REDACTED]')
    .replace(BEARER_TOKEN_RE, '$1[REDACTED]')
    .replace(GOOGLE_OAUTH_ACCESS_TOKEN_RE, '[REDACTED]')
    .replace(GOOGLE_OAUTH_REFRESH_TOKEN_RE, '[REDACTED]')
    .replace(QUOTED_KEY_VALUE_RE, '$1$2[REDACTED]$2')
    .replace(UNQUOTED_KEY_VALUE_RE, '$1[REDACTED]');
}
