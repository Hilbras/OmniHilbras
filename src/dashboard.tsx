import { createRoot } from 'react-dom/client';
import { Capacitor } from '@capacitor/core';
import { ToastProvider } from './components/Toast';
import { AndroidSetup } from './AndroidSetup';
import { SecureStore } from './lib/secureStore';
import './index.css';

// Apply the reduced-motion preference before the first paint of the dashboard.
try {
  if (localStorage.getItem('omnihilbras-reduce-motion') === 'true') {
    document.documentElement.classList.add('reduce-motion');
  }
} catch {
  // Storage unavailable; the CSS media query still applies.
}

const root = document.getElementById('root');
if (!root) throw new Error('#root element missing');

const reactRoot = createRoot(root);

function renderDashboard() {
  void import('./dashboardApp').then(({ default: DashboardApp }) => {
    reactRoot.render(
      <ToastProvider>
        <DashboardApp />
      </ToastProvider>,
    );
  });
}

async function boot() {
  if (!Capacitor.isNativePlatform()) {
    renderDashboard();
    return;
  }
  try {
    const saved = await SecureStore.get({ key: 'gateway' });
    if (saved.value) {
      const config = JSON.parse(saved.value) as { baseUrl?: string; token?: string };
      if (config.baseUrl) (globalThis as { __OMNIHILBRAS_GATEWAY_URL__?: string }).__OMNIHILBRAS_GATEWAY_URL__ = config.baseUrl;
      if (config.token) (globalThis as { __OMNIHILBRAS_GATEWAY_TOKEN__?: string }).__OMNIHILBRAS_GATEWAY_TOKEN__ = config.token;
      if (config.baseUrl && config.token) {
        renderDashboard();
        return;
      }
    }
  } catch {
    // An unreadable SecureStore is treated as an unpaired device, not a crash loop.
  }
  reactRoot.render(
    <ToastProvider>
      <AndroidSetup onPaired={renderDashboard} />
    </ToastProvider>,
  );
}

void boot();
