/** Shared loading and error presentation. Use these instead of ad-hoc markup. */

export function LoadingIndicator({ label = 'Loading…' }: { label?: string }) {
  return (
    <p role="status" className="text-sm text-slate-400">
      {label}
    </p>
  );
}

export function ErrorNotice({ message }: { message: string }) {
  return (
    <p role="alert" className="text-sm text-red-400">
      {message}
    </p>
  );
}
