import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | undefined;
}

/** Top-level render-error guard. Shows a recoverable fallback, never a blank page. */
export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: undefined };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('Unhandled render error', error, info.componentStack);
  }

  override render(): ReactNode {
    if (this.state.error === undefined) return this.props.children;

    return (
      <main role="alert" className="flex min-h-full flex-col items-center justify-center gap-4 p-8">
        <h1 className="text-xl font-semibold">Something went wrong</h1>
        <p className="text-slate-400">The interface hit an unexpected error.</p>
        <button
          type="button"
          className="rounded-md bg-slate-100 px-4 py-2 text-sm font-medium text-slate-900 hover:bg-white"
          onClick={() => {
            window.location.reload();
          }}
        >
          Reload
        </button>
      </main>
    );
  }
}
