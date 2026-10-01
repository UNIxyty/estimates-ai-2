'use client';

/** Theme preference: light | dark | system. `eaa-theme` holds the resolved theme read before first paint. */
export type ThemePref = 'light' | 'dark' | 'system';

export function currentTheme(): 'light' | 'dark' {
  return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
}

export function themePref(): ThemePref {
  try {
    const p = localStorage.getItem('eaa-theme-pref');
    if (p === 'light' || p === 'dark' || p === 'system') return p;
    return (localStorage.getItem('eaa-theme') as 'light' | 'dark') || 'light';
  } catch {
    return 'light';
  }
}

export function setThemePref(p: ThemePref): 'light' | 'dark' {
  const t = p === 'system' ? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light') : p;
  document.documentElement.dataset.theme = t;
  try {
    localStorage.setItem('eaa-theme-pref', p);
    localStorage.setItem('eaa-theme', t);
  } catch {}
  window.dispatchEvent(new CustomEvent('eaa:theme', { detail: t }));
  return t;
}
