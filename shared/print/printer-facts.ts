/** The closed sets a print failure fact may take; the collector rules and the PostHog scrub share them. */

export const PORT_KINDS = [
  'usb',
  'tcp_raw',
  'tcp_lpr',
  'wsd',
  'shared',
  'serial',
  'file',
  'ipp',
  'other',
  'unknown',
] as const;
export const QUEUE_REFUSALS = [
  'work_offline',
  'offline',
  'not_available',
  'paper_out',
  'paper_jam',
  'cover_open',
  'attention',
  'error',
] as const;
export const FAILURE_STEPS = [
  'open',
  'startdoc',
  'startpage',
  'write',
  'short_write',
  'timeout',
  'cancelled',
  'helper_start',
  'pre_spool',
] as const;
export const SNMP_STATES = ['yes', 'no'] as const;
export const DRIVER_KINDS = ['generic_text', 'ms_class', 'vendor', 'unknown'] as const;
export const BYPASS_OUTCOMES = ['failed', 'not_eligible'] as const;
export const WIN32_ERROR_MAX = 4294967295;
