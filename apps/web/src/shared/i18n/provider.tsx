'use client';
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
export type Locale = 'ru' | 'kk';
const Context = createContext<{ locale: Locale; setLocale: (v: Locale) => void }>({
  locale: 'ru',
  setLocale: () => {},
});
export function LanguageProvider({ children }: { children: ReactNode }) {
  const [locale, setLocale] = useState<Locale>('ru');
  useEffect(() => {
    try {
      if (localStorage.getItem('judo.locale') === 'kk') setLocale('kk');
    } catch {}
  }, []);
  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);
  function change(value: Locale) {
    setLocale(value);
    try {
      localStorage.setItem('judo.locale', value);
    } catch {}
  }
  return <Context.Provider value={{ locale, setLocale: change }}>{children}</Context.Provider>;
}
export function useLanguage() {
  const context = useContext(Context);
  return { ...context, text: (ru: string, kk: string) => (context.locale === 'kk' ? kk : ru) };
}
export function LanguageSwitch() {
  const { locale, setLocale } = useLanguage();
  return (
    <select
      aria-label="Язык / Тіл"
      value={locale}
      onChange={(e) => setLocale(e.target.value as Locale)}
      style={{ width: 'auto', fontSize: 12, padding: 8 }}
    >
      <option value="ru">Русский</option>
      <option value="kk">Қазақша</option>
    </select>
  );
}
