import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClientProvider } from '@tanstack/react-query';
import { App } from './app/App';
import { UiStoreProvider } from './app/UiStore';
import { queryClient } from './app/queryClient';
import './styles/tokens.css';
import './styles/phosphor.css';
import './styles/global.css';
import './styles/shell.css';
import './styles/provider-usage.css';
import './styles/conversation.css';
import './styles/composer-commands.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <UiStoreProvider>
        <App />
      </UiStoreProvider>
    </QueryClientProvider>
  </StrictMode>,
);
