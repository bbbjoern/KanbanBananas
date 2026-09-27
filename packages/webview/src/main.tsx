import { createRoot } from 'react-dom/client';
import { App, type Layout } from './App.js';
import { ErrorBoundary, reportClientError } from './ErrorBoundary.js';
import './styles.css';

const layout: Layout = document.body.dataset.layout === 'sidebar' ? 'sidebar' : 'panel';
window.addEventListener('error', (e) => reportClientError(e.error ?? e.message));
window.addEventListener('unhandledrejection', (e) => reportClientError(e.reason));
createRoot(document.getElementById('root')!).render(
  <ErrorBoundary>
    <App layout={layout} />
  </ErrorBoundary>,
);

if (import.meta.env.DEV) void import('./dev.js');
