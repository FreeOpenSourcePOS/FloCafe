/** Core i18n barrel exporting registry, chunk loader,
 * detection utilities, and domain enum mappings. */

export {
  LANGUAGES,
  getLanguageDirection,
  getLanguageFromLocale,
  getLanguageLocale,
  type Language,
  type LanguageConfig,
  type LanguageDirection,
  type Locale,
} from './languages';

export {
  loadLocaleMessages,
  getCachedMessages,
  isLocaleLoaded,
} from './loader';

export {
  getBrowserLanguage,
} from './browser-language';

export {
  fetchServerInfo,
  useSyncServerLanguage,
  type ServerInfo,
} from './server-language';

export {
  ORDER_TYPE_LABEL_KEYS,
  ROLE_LABEL_KEYS,
  ORDER_STATUS_LABEL_KEYS,
  ITEM_STATUS_LABEL_KEYS,
  TABLE_STATUS_LABEL_KEYS,
  TENANT_STATUS_LABEL_KEYS,
  BUSINESS_TYPE_LABEL_KEYS,
  PAYMENT_STATUS_LABEL_KEYS,
} from './enums';
