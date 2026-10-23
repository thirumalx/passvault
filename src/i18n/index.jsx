import React, { createContext, useContext, useState, useEffect } from 'react';
import en from './locales/en.json';
import ta from './locales/ta.json';
import kn from './locales/kn.json';
import ml from './locales/ml.json';
import hi from './locales/hi.json';
import fr from './locales/fr.json';
import es from './locales/es.json';

const translations = {
  en,
  ta,
  kn,
  ml,
  hi,
  fr,
  es
};

export const SUPPORTED_LANGUAGES = [
  { code: 'en', label: 'English', native: 'English' },
  { code: 'ta', label: 'Tamil', native: 'தமிழ்' },
  { code: 'kn', label: 'Kannada', native: 'ಕನ್ನಡ' },
  { code: 'ml', label: 'Malayalam', native: 'മലയാളം' },
  { code: 'hi', label: 'Hindi', native: 'हिन्दी' },
  { code: 'fr', label: 'French', native: 'Français' },
  { code: 'es', label: 'Spanish', native: 'Español' }
];

const I18nContext = createContext(null);

export function I18nProvider({ children }) {
  const [lang, setLangState] = useState(() => {
    try {
      const saved = localStorage.getItem('passvault_language');
      if (saved && translations[saved]) return saved;
      // Auto-detect browser language if supported
      const navLang = (navigator.language || '').slice(0, 2).toLowerCase();
      if (translations[navLang]) return navLang;
    } catch (e) {}
    return 'en';
  });

  const setLanguage = (newLang) => {
    if (translations[newLang]) {
      setLangState(newLang);
      try {
        localStorage.setItem('passvault_language', newLang);
      } catch (e) {}
    }
  };

  const t = (keyPath, fallback = '') => {
    const keys = keyPath.split('.');
    let current = translations[lang];
    for (const k of keys) {
      if (current && typeof current === 'object' && k in current) {
        current = current[k];
      } else {
        current = undefined;
        break;
      }
    }
    if (typeof current === 'string') return current;

    // Fallback to English
    let engCurrent = translations['en'];
    for (const k of keys) {
      if (engCurrent && typeof engCurrent === 'object' && k in engCurrent) {
        engCurrent = engCurrent[k];
      } else {
        engCurrent = undefined;
        break;
      }
    }
    if (typeof engCurrent === 'string') return engCurrent;

    return fallback || keyPath;
  };

  return (
    <I18nContext.Provider value={{ lang, setLanguage, t, languages: SUPPORTED_LANGUAGES }}>
      {children}
    </I18nContext.Provider>
  );
}

export function useI18n() {
  const ctx = useContext(I18nContext);
  if (!ctx) {
    // Graceful fallback outside provider
    return {
      lang: 'en',
      setLanguage: () => {},
      t: (k, fb) => fb || k,
      languages: SUPPORTED_LANGUAGES
    };
  }
  return ctx;
}

