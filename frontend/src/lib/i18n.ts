/** Root i18n barrel re-exporting the modular i18n subsystem. */

export {
  LANGUAGES,
  getLanguageDirection,
  getLanguageFromLocale,
  getLanguageLocale,
  isLanguage,
  type Language,
  type LanguageConfig,
  type LanguageDirection,
  type Locale,
} from './i18n/languages';

export {
  loadLocaleMessages,
  getCachedMessages,
  isLocaleLoaded,
} from './i18n/loader';

export {
  getBrowserLanguage,
} from './i18n/browser-language';

export {
  fetchServerInfo,
  useSyncServerLanguage,
  type ServerInfo,
} from './i18n/server-language';

export {
  ORDER_TYPE_LABEL_KEYS,
  ROLE_LABEL_KEYS,
  ORDER_STATUS_LABEL_KEYS,
  ITEM_STATUS_LABEL_KEYS,
  TABLE_STATUS_LABEL_KEYS,
  TENANT_STATUS_LABEL_KEYS,
  BUSINESS_TYPE_LABEL_KEYS,
  PAYMENT_STATUS_LABEL_KEYS,
} from './i18n/enums';
