import { createRoot } from 'react-dom/client';
import ProviderDetailPage from './pages/ProviderDetailPage';
import './index.css';

const root = document.getElementById('root');
if (!root) throw new Error('#root element missing');

createRoot(root).render(<ProviderDetailPage />);
