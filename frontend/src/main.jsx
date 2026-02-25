import React, { useState } from 'react';
import ReactDOM from 'react-dom/client';
import { WagmiProvider } from 'wagmi';
import { RainbowKitProvider, darkTheme } from '@rainbow-me/rainbowkit';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import '@rainbow-me/rainbowkit/styles.css';

import { config } from './wagmi';
import ArenaDashboard from './App';
import Landing from './Landing';

const queryClient = new QueryClient();

function ArenaApp() {
  const [page, setPage] = useState('landing');

  if (page === 'landing') {
    return <Landing onEnter={() => setPage('dashboard')} />;
  }

  return <ArenaDashboard />;
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <WagmiProvider config={config}>
      <QueryClientProvider client={queryClient}>
        <RainbowKitProvider
          theme={darkTheme({
            accentColor: '#d9982e',
            accentColorForeground: '#06070a',
            borderRadius: 'none',
            fontStack: 'system',
          })}
        >
          <ArenaApp />
        </RainbowKitProvider>
      </QueryClientProvider>
    </WagmiProvider>
  </React.StrictMode>
);
