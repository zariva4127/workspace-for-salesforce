import { render } from 'preact';
import { App } from './App';
import { WorkspaceProvider } from './state/workspace';
import { ToastProvider } from './components/Toasts';

render(
  <WorkspaceProvider>
    <ToastProvider>
      <App />
    </ToastProvider>
  </WorkspaceProvider>,
  document.getElementById('app')!,
);
