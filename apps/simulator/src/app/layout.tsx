import type { ReactNode } from 'react';
import './globals.css';

export const metadata = {
  title: 'HomeLedger simulator',
  description: 'A simulated smart-display client driving the HomeLedger MCP server.'
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" data-theme="dark">
      <body>{children}</body>
    </html>
  );
}
