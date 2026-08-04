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
