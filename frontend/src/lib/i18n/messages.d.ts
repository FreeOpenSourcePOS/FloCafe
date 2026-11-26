import type en from './messages/en.json';
import type pizza from './messages-pizza/en.json';
import type { Locale } from './languages';

type Messages = typeof en & { pizza: typeof pizza };

declare module 'use-intl' {
  interface AppConfig {
    Messages: Messages;
    Locale: Locale;
  }
}
