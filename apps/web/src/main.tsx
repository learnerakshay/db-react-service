import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { ErrorBoundary } from './components/ErrorBoundary';
import { HomePage } from './pages/HomePage';
import './index.css';

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error('Root element #root not found');
}

// Single page in Phase 0. Add a router when a second page exists.
createRoot(rootElement).render(
  <StrictMode>
    <ErrorBoundary>
      <HomePage />
    </ErrorBoundary>
  </StrictMode>,
);
