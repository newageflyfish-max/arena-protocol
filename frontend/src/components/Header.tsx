'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { ConnectButton } from '@rainbow-me/rainbowkit';

const NAV_LINKS = [
  { href: '/', label: 'Home' },
  { href: '/tasks', label: 'Tasks' },
  { href: '/create', label: 'Create' },
  { href: '/agents', label: 'Agents' },
  { href: '/verifiers', label: 'Verifiers' },
  { href: '/dashboard', label: 'Dashboard' },
  { href: '/insurance', label: 'Insurance' },
  { href: '/arbitration', label: 'Arbitration' },
  { href: '/settings', label: 'Settings' },
];

export function Header() {
  const pathname = usePathname();

  return (
    <header className="fixed top-0 left-0 right-0 z-50 h-14 bg-navy-900 border-b border-zinc-800 flex items-center justify-between px-6">
      {/* Left: Logo */}
      <Link href="/" className="font-mono font-bold text-white text-sm tracking-widest uppercase">
        THE ARENA
      </Link>

      {/* Center: Navigation */}
      <nav className="hidden md:flex items-center gap-1">
        {NAV_LINKS.map((link) => {
          const isActive =
            link.href === '/'
              ? pathname === '/'
              : pathname.startsWith(link.href);

          return (
            <Link
              key={link.href}
              href={link.href}
              className={`px-3 py-1.5 rounded text-xs font-medium transition-colors ${
                isActive
                  ? 'bg-navy-800 text-white'
                  : 'text-zinc-400 hover:text-zinc-200 hover:bg-navy-800/50'
              }`}
            >
              {link.label}
            </Link>
          );
        })}
      </nav>

      {/* Right: Wallet */}
      <div className="flex items-center">
        <ConnectButton
          accountStatus="address"
          chainStatus="icon"
          showBalance={false}
        />
      </div>
    </header>
  );
}
