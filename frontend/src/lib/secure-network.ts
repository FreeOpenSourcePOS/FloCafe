export interface SecureNetworkDiagnostic {
  id: string;
  status: 'ok' | 'warn' | 'fail' | 'skipped';
  code: string;
  surface?: 'main' | 'kds' | 'serverApp';
}

/** Maps the backend's stable diagnostic codes to translation keys in the `secureNetwork` namespace. */
export const SECURE_NETWORK_DIAGNOSTIC_KEYS: Record<
  string,
  | 'diagLanIpOk'
  | 'diagLanIpChanged'
  | 'diagPortOk'
  | 'diagPortUnavailable'
  | 'diagHttpsOk'
  | 'diagHttpsUnreachable'
  | 'diagCertificateOk'
  | 'diagCertificateExpiring'
  | 'diagCertificateBad'
  | 'diagBackendOk'
  | 'diagBackendDown'
  | 'diagWebsocketOk'
  | 'diagWebsocketFailed'
  | 'diagFirewallOk'
  | 'diagFirewallMissing'
  | 'diagProfileOk'
  | 'diagProfilePublic'
  | 'diagProfileDomain'
  | 'diagDisabled'
  | 'noticeStorage'
> = {
  lan_ip_ok: 'diagLanIpOk',
  lan_ip_changed: 'diagLanIpChanged',
  port_ok: 'diagPortOk',
  port_unavailable: 'diagPortUnavailable',
  https_ok: 'diagHttpsOk',
  https_unreachable: 'diagHttpsUnreachable',
  certificate_valid: 'diagCertificateOk',
  certificate_expiring: 'diagCertificateExpiring',
  certificate_attention: 'diagCertificateBad',
  certificate_missing: 'diagCertificateBad',
  backend_ok: 'diagBackendOk',
  backend_unreachable: 'diagBackendDown',
  websocket_ok: 'diagWebsocketOk',
  websocket_failed: 'diagWebsocketFailed',
  firewall_ok: 'diagFirewallOk',
  firewall_rule_missing: 'diagFirewallMissing',
  network_profile_ok: 'diagProfileOk',
  network_profile_public: 'diagProfilePublic',
  network_profile_domain: 'diagProfileDomain',
  disabled: 'diagDisabled',
  secure_storage_unavailable: 'noticeStorage',
};
