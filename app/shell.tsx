"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

const DESTINATIONS = [
  { href: "/", label: "Rail" },
  { href: "/studio", label: "Studio" },
  { href: "/calendar", label: "Calendar" },
  { href: "/operations", label: "Operations" },
  { href: "/learning", label: "Learning" },
  { href: "/projects", label: "Project Connection" },
  { href: "/connections", label: "Host Connections" },
] as const;

async function signOut() {
  await fetch("/api/auth/logout", { method: "POST" });
  window.location.href = "/login";
}

export function Shell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  return (
    <div className="shell">
      <nav className="shell-nav" aria-label="Destinations">
        <div className="shell-brand">MarketingOS</div>
        <button className="project-switcher" aria-label="Project switcher" title="Connect a project to switch between Connected Projects">
          No Connected Projects yet
        </button>
        <ul className="shell-nav-list">
          {DESTINATIONS.map((d) => (
            <li key={d.href}>
              <Link
                className="shell-nav-link"
                href={d.href}
                aria-current={pathname === d.href ? "page" : undefined}
              >
                {d.label}
              </Link>
            </li>
          ))}
        </ul>
        <div className="shell-nav-foot">
          <button className="action-quiet" onClick={signOut}>
            Sign out
          </button>
        </div>
      </nav>
      <main className="shell-main">{children}</main>
    </div>
  );
}

export function EmptyState({
  tag,
  title,
  children,
  action,
}: {
  tag?: string;
  title: string;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <section className="empty-state">
      {tag && <span className="tag">{tag}</span>}
      <h1 className="headline" style={{ marginTop: tag ? "var(--space-2)" : 0 }}>
        {title}
      </h1>
      <div className="body-text">{children}</div>
      {action}
    </section>
  );
}
