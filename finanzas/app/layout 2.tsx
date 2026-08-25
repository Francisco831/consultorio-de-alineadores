import type { Metadata } from "next";
import { Rethink_Sans, Geist_Mono } from "next/font/google";
import { ThemeProvider } from "next-themes";
import { Toaster } from "@/components/ui/sonner";
import "./globals.css";

const rethinkSans = Rethink_Sans({
  variable: "--font-rethink",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Finanzas — KS México · Consultorio AR",
  description: "Sistema de administración financiera",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="es"
      suppressHydrationWarning
      className={`${rethinkSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      {/* suppressHydrationWarning: las extensiones del navegador (Grammarly y
          cía.) inyectan atributos en el body antes de que React hidrate y el
          overlay de dev lo reporta como error; no es nuestro. */}
      <body suppressHydrationWarning className="min-h-full flex flex-col">
        <ThemeProvider attribute="class" defaultTheme="system" enableSystem>
          {children}
          <Toaster />
        </ThemeProvider>
      </body>
    </html>
  );
}
