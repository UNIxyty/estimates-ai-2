/** Marks every page as a functional shell until the Claude Design project is imported. */
export function DesignPending() {
  return (
    <p role="note" data-design-pending="">
      <small>UI shell — design import pending</small>
    </p>
  );
}
