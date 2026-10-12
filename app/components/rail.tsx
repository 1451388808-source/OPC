"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const modules = [
  { href: "/", label: "看板", match: (path: string) => path === "/" },
  { href: "/roles", label: "员工", match: (path: string) => path.startsWith("/roles") },
  { href: "/company", label: "公司", match: (path: string) => path.startsWith("/company") },
];

export function Rail() {
  const pathname = usePathname();

  return (
    <aside className="rail" aria-label="功能模块">
      <Link className="mark-link" href="/" aria-label="OPC">
        <svg className="mark" viewBox="0 0 32 32" role="img">
          <defs>
            <linearGradient id="opc" x1="4" y1="2" x2="28" y2="30">
              <stop stopColor="#60a5fa" />
              <stop offset="1" stopColor="#1d4ed8" />
            </linearGradient>
          </defs>
          <rect width="32" height="32" rx="9" fill="url(#opc)" />
          <path
            d="M11 20.5V13.2c0-1.3 1-2.3 2.3-2.3h7.4"
            fill="none"
            stroke="#fff"
            strokeWidth="2.1"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <circle cx="20.2" cy="19.6" r="2.15" fill="#fff" />
        </svg>
      </Link>
      {modules.map((item) => (
        <Link
          key={item.href}
          href={item.href}
          className={item.match(pathname) ? "rail-link active" : "rail-link"}
          aria-current={item.match(pathname) ? "page" : undefined}
        >
          <ModuleIcon name={item.label} />
          {item.label}
        </Link>
      ))}
    </aside>
  );
}

function ModuleIcon({ name }: { name: string }) {
  if (name === "看板") {
    return (
      <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.6">
        <rect x="2" y="2" width="5" height="14" rx="1.2" />
        <rect x="9" y="2" width="7" height="6" rx="1.2" />
        <rect x="9" y="10" width="7" height="6" rx="1.2" />
      </svg>
    );
  }
  if (name === "员工") {
    return (
      <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.6">
        <circle cx="9" cy="6" r="2.4" />
        <path d="M4.5 15c.8-2.6 2.5-3.8 4.5-3.8s3.7 1.2 4.5 3.8" strokeLinecap="round" />
      </svg>
    );
  }
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.6">
      <path d="M4 3.5h7l3 3V14.5H4z" />
      <path d="M11 3.5V7h3" />
    </svg>
  );
}
