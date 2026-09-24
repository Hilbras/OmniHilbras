import { createRoot } from 'react-dom/client';
import ProvidersPage from './pages/ProvidersPage';
import './index.css';

const root = document.getElementById('root');
if (!root) throw new Error('#root element missing');

createRoot(root).render(<ProvidersPage />);
