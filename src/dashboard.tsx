import { createRoot } from 'react-dom/client';
import DashboardOverview from './pages/DashboardOverview';
import './index.css';

const root = document.getElementById('root');
if (!root) throw new Error('#root element missing');

createRoot(root).render(<DashboardOverview />);
