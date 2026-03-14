import type { Metadata } from 'next';
import { Noto_Sans_JP } from 'next/font/google';
import './globals.css';

const notoSansJP = Noto_Sans_JP({
  subsets: ['latin'],
  display: 'swap',
});

export const metadata: Metadata = {
  title: '議事録アプリ',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="ja">
      <body className={notoSansJP.className} style={{ backgroundColor: '#0f0f0f' }}>
        {children}
      </body>
    </html>
  );
}
