import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from '@/app/App';
import { ErrorBoundary } from '@/app/ErrorBoundary';
import { initTheme } from '@/theme/theme-store';
import '@/theme/theme.css';

// Apply the stored theme before the first paint.
initTheme();

const container = document.getElementById('root');
if (!container) throw new Error('missing #root');

createRoot(container).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
);

// Startup succeeded: `boot-guard` has nothing left to report.
document.getElementById('boot')?.remove();

// Built with `--mode selftest`, the window tests itself: see
// `src/self-test/runner.ts` and `scripts/self-test.sh`. The condition is a
// build-time constant, so an ordinary build drops the branch and the module with
// it.
if (import.meta.env.MODE === 'selftest') {
  void import('@/self-test/runner').then((runner) => runner.start());
}
