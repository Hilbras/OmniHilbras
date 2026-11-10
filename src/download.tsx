import { createRoot } from 'react-dom/client';
import DownloadPage from './DownloadPage';
import { ToastProvider } from './components/Toast';
import './index.css';

const root = document.getElementById('root');
if (!root) throw new Error('#root element missing');

createRoot(root).render(
  <ToastProvider>
    <DownloadPage />
  </ToastProvider>,
);
