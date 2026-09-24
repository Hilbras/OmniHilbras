import { createRoot } from 'react-dom/client';
import RoutingPage from './pages/RoutingPage';
import './index.css';

const root = document.getElementById('root');
if (!root) throw new Error('#root element missing');

createRoot(root).render(<RoutingPage />);
