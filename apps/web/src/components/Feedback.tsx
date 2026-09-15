/** Shared loading and error presentation. Use these instead of ad-hoc markup. */

export function LoadingIndicator({ label = 'Loading…' }: { label?: string }) {
  return (
    <p role="status" className="text-sm text-zinc-400">
      {label}
    </p>
  );
}

export function ErrorNotice({ message }: { message: string }) {
  return (
    <p role="alert" className="text-sm text-rose-300">
      {message}
    </p>
  );
}
