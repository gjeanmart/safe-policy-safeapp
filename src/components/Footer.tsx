const REPO_URL = 'https://github.com/gjeanmart/safe-policy-safeapp'

/** Bottom bar: Notes, app version and the commit this build comes from. */
export function Footer({ onOpenNotes }: { onOpenNotes: () => void }) {
  const commit = __COMMIT_SHA__
  return (
    <footer className="app-footer">
      <button type="button" className="link" onClick={onOpenNotes}>
        Notes
      </button>
      <span aria-hidden="true">·</span>
      <span>v{__APP_VERSION__}</span>
      <span aria-hidden="true">·</span>
      {commit ? (
        <a href={`${REPO_URL}/commit/${commit}`} target="_blank" rel="noreferrer" className="mono">
          {commit.slice(0, 7)}
        </a>
      ) : (
        <span className="mono">dev</span>
      )}
      <span aria-hidden="true">·</span>
      <a href={REPO_URL} target="_blank" rel="noreferrer">
        GitHub
      </a>
    </footer>
  )
}
