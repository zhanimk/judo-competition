import { LanguageProvider } from '../shared/i18n/provider';
import type { Metadata } from 'next';
import './globals.css';
export const metadata: Metadata = {
  title: 'Judo Child League — Управление турнирами',
  description: 'Подготовка и проведение соревнований по дзюдо',
};
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ru">
      <body>
        <LanguageProvider>{children}</LanguageProvider>
      </body>
    </html>
  );
}
