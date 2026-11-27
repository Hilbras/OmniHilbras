import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { ToastProvider } from './components/Toast';
import { I18nProvider, type Locale } from './i18n';
import './index.css';

const root = document.getElementById('root');
if (!root) throw new Error('#root element missing');

// The toast provider wraps the whole app: every page reports the outcome of an action the same way,
// rather than each one growing its own banner above the fold.
/**
 * The language is chosen once from the browser and lives for the session.
 *
 * It is deliberately not written to storage: a locale preference is not a credential, but it is
 * also not worth a second allowlisted key in the browser-storage guard. A user who wants Arabic
 * gets it from their browser setting, and the catalogue proves the layout in both directions.
 */
function Root() {
  const [locale, setLocale] = useState<Locale>(() => (navigator.language ?? '').toLowerCase().startsWith('ar') ? 'ar' : 'en');
  return (
    <I18nProvider locale={locale} onChange={setLocale}>
      <ToastProvider>
        <App />
      </ToastProvider>
    </I18nProvider>
  );
}

createRoot(root).render(<Root />);

// The shell is installable and answers a navigation offline; it never caches `/v1`.
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => undefined);
  });
}
