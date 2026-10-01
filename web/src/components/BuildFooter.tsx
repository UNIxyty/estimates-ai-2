/** Quiet build hash (also in /api/health) so you can confirm which bundle is live. Shown on the sign-in pages;
 *  in the app it sits in the sidebar footer. */
export function BuildFooter() {
  const hash = process.env.BUILD_HASH || process.env.NEXT_PUBLIC_BUILD_HASH || 'dev';
  return (
    <footer style={{ position: 'fixed', right: 12, bottom: 8, fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--ink3)', opacity: 0.7 }}>
      <small data-build={hash}>build {hash}</small>
    </footer>
  );
}
