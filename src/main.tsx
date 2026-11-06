import { createRoot } from 'react-dom/client';
import App from './App';
import { ToastProvider } from './components/Toast';
import './index.css';

const root = document.getElementById('root');
if (!root) throw new Error('#root element missing');

// The toast provider wraps the whole app: every page reports the outcome of an action the same way,
// rather than each one growing its own banner above the fold.
createRoot(root).render(
  <ToastProvider>
    <App />
  </ToastProvider>,
);
