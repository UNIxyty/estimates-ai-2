/**
 * MGS brand mark: "MGS" in Broadway (falls back to Georgia where Broadway isn't installed), a 1px divider, then
 * "Estimates AI". Sizes from the brand spec: top bar 24px, login 30px, walkthrough modal 22px.
 * Colours are tokens (--brand, --brand-divider, --brand-divider-strong, --brand-name) so dark mode stays legible.
 */
import type { CSSProperties } from 'react';

export const BRAND_FONT = "'Broadway BT', 'Broadway', Georgia, serif";

type Variant = 'topbar' | 'login' | 'modal';
const SIZE: Record<Variant, number> = { topbar: 24, login: 30, modal: 22 };

export function BrandLogo({ size = 24, style }: { size?: number; style?: CSSProperties }) {
  return (
    <span aria-label="MGS" style={{ fontFamily: BRAND_FONT, fontWeight: 400, fontSize: size, lineHeight: 1, color: 'var(--brand)', letterSpacing: '0.01em', whiteSpace: 'nowrap', ...style }}>
      MGS
    </span>
  );
}

export function Brand({ variant = 'topbar', showName = true, style }: { variant?: Variant; showName?: boolean; style?: CSSProperties }) {
  const size = SIZE[variant];
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: Math.round(size * 0.42), minWidth: 0, ...style }}>
      <BrandLogo size={size} />
      {showName && (
        <>
          <span aria-hidden style={{ width: 1, height: Math.round(size * 0.9), flex: 'none', background: variant === 'login' ? 'var(--brand-divider-strong)' : 'var(--brand-divider)' }} />
          <span style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--brand-name)', whiteSpace: 'nowrap', letterSpacing: '-0.005em' }}>Estimates AI</span>
        </>
      )}
    </span>
  );
}
