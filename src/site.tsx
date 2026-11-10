import { createRoot } from 'react-dom/client';
import SitePage from './SitePage';
import { ToastProvider } from './components/Toast';
import './index.css';

const root = document.getElementById('root');
if (!root) throw new Error('#root element missing');

createRoot(root).render(
  <ToastProvider>
    <SitePage />
  </ToastProvider>,
);
