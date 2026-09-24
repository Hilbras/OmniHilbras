import { createRoot } from 'react-dom/client';
import DashboardApp from './dashboardApp';
import './index.css';

const root = document.getElementById('root');
if (!root) throw new Error('#root element missing');

createRoot(root).render(<DashboardApp />);
