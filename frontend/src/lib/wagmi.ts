'use client';

import { createConfig, http } from 'wagmi';
import { baseSepolia } from 'wagmi/chains';
import { injectedWallet, coinbaseWallet, phantomWallet } from '@rainbow-me/rainbowkit/wallets';
import { connectorsForWallets } from '@rainbow-me/rainbowkit';

const connectors = connectorsForWallets(
  [
    {
      groupName: 'Installed',
      wallets: [injectedWallet, coinbaseWallet, phantomWallet],
    },
  ],
  {
    appName: 'Arena Protocol',
    projectId: 'none',
  }
);

export const config = createConfig({
  connectors,
  chains: [baseSepolia],
  transports: {
    [baseSepolia.id]: http(process.env.NEXT_PUBLIC_RPC_URL || 'https://sepolia.base.org'),
  },
  ssr: true,
});
