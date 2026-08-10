import type { Metadata } from "next";
import { Rethink_Sans, Geist_Mono } from "next/font/google";
import "./globals.css";

// Rethink Sans = tipografía de marca de KeepSmiling (keepsmiling.com.ar)
const rethinkSans = Rethink_Sans({
  variable: "--font-rethink",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "KeepSmiling México — CRM",
  description: "Commercial Operating System de KeepSmiling México",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="es"
      className={`${rethinkSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
