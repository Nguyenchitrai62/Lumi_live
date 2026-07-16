import type { Metadata } from "next";
import { headers } from "next/headers";
import "./globals.css";

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const host = requestHeaders.get("x-forwarded-host") ?? requestHeaders.get("host") ?? "localhost:3001";
  const protocol = requestHeaders.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  const origin = `${protocol}://${host}`;

  return {
    metadataBase: new URL(origin),
    title: "Lumi Live — Voice Roleplay Companion",
    description: "A cozy real-time voice roleplay experience with Lumi, powered by Gemini Live.",
    icons: {
      icon: [{ url: "/branding/logo.png", type: "image/png" }],
      shortcut: "/branding/logo.png",
      apple: "/branding/logo.png",
    },
    openGraph: {
      title: "Lumi Live",
      description: "A voice, a story, a world together.",
      type: "website",
      images: [{ url: `${origin}/og.png`, width: 1728, height: 910, alt: "Lumi Live voice roleplay companion" }],
    },
    twitter: {
      card: "summary_large_image",
      title: "Lumi Live",
      description: "A voice, a story, a world together.",
      images: [`${origin}/og.png`],
    },
  };
}

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var p=localStorage.getItem("lumi-theme")||"system";if(!/^(system|light|dark)$/.test(p))p="system";var t=p==="system"?(matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light"):p;document.documentElement.dataset.theme=t;document.documentElement.dataset.themePreference=p}catch(e){}})();`,
          }}
        />
      </head>
      <body>{children}</body>
    </html>
  );
}
