import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = {
  title: "MarketingOS",
  description: "A personal, multi-project marketing workspace.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          fontFamily: "Georgia, 'Times New Roman', serif",
          background: "#faf9f7",
          color: "#1a1a18",
        }}
      >
        {children}
      </body>
    </html>
  );
}
