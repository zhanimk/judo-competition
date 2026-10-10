'use client';
import { useLanguage, LanguageSwitch } from '../../shared/i18n/provider';
import { AuthGate } from '../../features/auth/auth-gate';
import { logoutSession } from '../../features/auth/logout';
import { request } from '../../features/tournaments/api';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { Brand } from './brand';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';
import './platform.css';
export function PlatformShell({ children }: { children: ReactNode }) {
  const path = usePathname();
  const [admin, setAdmin] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [logoutError, setLogoutError] = useState(false),
    [loggingOut, setLoggingOut] = useState(false);
  const menuToggle = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    try {
      const saved = localStorage.getItem('jcl.sidebar.open');
      setSidebarOpen(
        saved === null ? !window.matchMedia('(max-width: 760px)').matches : saved === 'true',
      );
    } catch {
      setSidebarOpen(!window.matchMedia('(max-width: 760px)').matches);
    }
  }, []);
  function setMenu(open: boolean) {
    setSidebarOpen(open);
    try {
      localStorage.setItem('jcl.sidebar.open', String(open));
    } catch {
      /* Storage can be unavailable in private browsers. */
    }
    if (!open) menuToggle.current?.focus();
  }
  useEffect(() => {
    request<{ role: string }>('/auth/me')
      .then((u) => setAdmin(u.role === 'SUPER_ADMIN'))
      .catch(() => {});
  }, []);
  const { text } = useLanguage();
  return (
    <AuthGate>
      <div className={`platform${sidebarOpen ? '' : ' sidebar-closed'}`}>
        <a className="skip-link" href="#main-content">
          {text('К содержимому', 'Мазмұнға өту')}
        </a>
        <aside
          id="platform-sidebar"
          className="sidebar"
          hidden={!sidebarOpen}
          onKeyDown={(event) => {
            if (event.key === 'Escape') setMenu(false);
          }}
        >
          <button
            type="button"
            className="sidebar-close"
            onClick={() => setMenu(false)}
            aria-label={text('Скрыть меню', 'Мәзірді жасыру')}
            title={text('Скрыть меню', 'Мәзірді жасыру')}
          >
            ×
          </button>
          <Link className="platform-logo" href="/" aria-label="Judo Child League">
            <Brand />
          </Link>
          <p className="nav-label">{text('РАБОЧЕЕ ПРОСТРАНСТВО', 'ЖҰМЫС КЕҢІСТІГІ')}</p>
          <nav aria-label={text('Основная навигация', 'Негізгі навигация')}>
            {[{ href: '/tournaments', label: text('Соревнования', 'Жарыстар'), icon: '▦' }].map(
              (item) => (
                <Link
                  key={item.href}
                  className={
                    path === item.href ||
                    (item.href === '/tournaments' && path.startsWith('/tournaments/'))
                      ? 'selected'
                      : ''
                  }
                  href={item.href}
                >
                  <span>{item.icon}</span>
                  {item.label}
                </Link>
              ),
            )}
            {admin && (
              <Link href="/admin/users" className={path === '/admin/users' ? 'selected' : ''}>
                {text('Пользователи', 'Пайдаланушылар')}
              </Link>
            )}
          </nav>
          <div className="sidebar-bottom">
            <span className="local-dot" />
            {text('Работа с турниром', 'Турнирді басқару')}
            <p>
              {text(
                'Подготовка, татами и результаты — внутри турнира.',
                'Дайындық, татами және нәтижелер — турнир ішінде.',
              )}
            </p>
          </div>
        </aside>
        <div className="platform-main">
          <header className="platform-top">
            <div className="platform-heading">
              <button
                ref={menuToggle}
                type="button"
                className="menu-toggle"
                onClick={() => setMenu(!sidebarOpen)}
                aria-expanded={sidebarOpen}
                aria-controls="platform-sidebar"
                aria-label={
                  sidebarOpen
                    ? text('Скрыть меню', 'Мәзірді жасыру')
                    : text('Показать меню', 'Мәзірді көрсету')
                }
                title={
                  sidebarOpen
                    ? text('Скрыть меню', 'Мәзірді жасыру')
                    : text('Показать меню', 'Мәзірді көрсету')
                }
              >
                <svg
                  width="22"
                  height="22"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  aria-hidden="true"
                >
                  <rect x="3" y="4" width="18" height="16" rx="3" />
                  <path d="M9 4v16" />
                  {sidebarOpen ? <path d="m16 9-3 3 3 3" /> : <path d="m13 9 3 3-3 3" />}
                </svg>
              </button>
              <span className="platform-role">{text('Администратор', 'Әкімші')}</span>
            </div>
            <div>
              <LanguageSwitch />

              <button
                disabled={loggingOut}
                onClick={async () => {
                  setLoggingOut(true);
                  setLogoutError(false);
                  try {
                    await logoutSession();
                    location.href = '/login';
                  } catch {
                    setLogoutError(true);
                    setLoggingOut(false);
                  }
                }}
              >
                {text('Выйти', 'Шығу')}
              </button>
            </div>
          </header>
          {logoutError && (
            <p className="error-box" role="alert">
              {text('Выход не выполнен. Повторите.', 'Жүйеден шығу орындалмады. Қайталаңыз.')}
            </p>
          )}
          <main id="main-content" className="platform-content" tabIndex={-1}>
            {children}
          </main>
          <footer className="platform-footer">
            Judo Child League
            <span>{text('Система управления соревнованиями', 'Жарыстарды басқару жүйесі')}</span>
          </footer>
        </div>
      </div>
    </AuthGate>
  );
}
