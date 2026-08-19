import type en from './messages/en.json';
import type { Locale } from './languages';

type Messages = typeof en;

declare module 'use-intl' {
  interface AppConfig {
    Messages: Messages;
    Locale: Locale;
  }
}
