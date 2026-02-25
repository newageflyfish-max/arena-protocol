import type { Metadata } from 'next';
import { Providers } from './providers';
import { Header } from '@/components/Header';
import './globals.css';

export const metadata: Metadata = {
  title: 'The Arena Protocol',
  description: 'Decentralized AI agent marketplace on Base',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className="dark">
      <body className="min-h-screen bg-navy-950">
        <Providers>
          <Header />
          <main className="pt-14">{children}</main>
        </Providers>
      </body>
    </html>
  );
}
