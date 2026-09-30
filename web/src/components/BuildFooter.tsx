export function BuildFooter() {
  const hash = process.env.BUILD_HASH || process.env.NEXT_PUBLIC_BUILD_HASH || 'dev';
  return (
    <footer>
      <small>build {hash}</small>
    </footer>
  );
}
