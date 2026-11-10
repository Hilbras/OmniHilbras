import { createRoot } from 'react-dom/client';
import DashboardApp from './dashboardApp';
import { ToastProvider } from './components/Toast';
import './index.css';

// Apply the reduced-motion preference before the first paint of the dashboard, not only when the
// Settings page happens to be opened.
try {
  if (localStorage.getItem('omnihilbras-reduce-motion') === 'true') {
    document.documentElement.classList.add('reduce-motion');
  }
} catch {
  // Storage unavailable; the CSS media query still applies.
}

const root = document.getElementById('root');
if (!root) throw new Error('#root element missing');

// The toast provider wraps the whole app: every page reports the outcome of an action the same way,
// rather than each one growing its own banner above the fold.
//
// **Both** entries need this. The site (`main.tsx`) and the dashboard (`dashboard.tsx`) are separate
// React roots — this one is what loads `/dashboard/providers`, so wrapping only the other left every
// provider page throwing `useToast must be used inside ToastProvider` at first render.
createRoot(root).render(
  <ToastProvider>
    <DashboardApp />
  </ToastProvider>,
);
