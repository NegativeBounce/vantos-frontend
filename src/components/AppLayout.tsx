import type { ReactNode } from "react";
import { NavLink } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { getHealth } from "../lib/api";
import { useAuth } from "../lib/auth";

const NAV = [
  { to: "/", label: "Map", end: true },
  { to: "/reports", label: "Reports" },
  { to: "/subscribers", label: "Subscribers" },
  { to: "/admin", label: "Admin" },
  { to: "/settings", label: "Settings" },
];

export default function AppLayout({ children }: { children: ReactNode }) {
  const { logout } = useAuth();
  const health = useQuery({ queryKey: ["health"], queryFn: getHealth });

  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden">
      <header className="flex items-center justify-between border-b border-white/10 bg-black/60 px-4 py-2 backdrop-blur">
        <div className="flex items-center gap-4">
          <span className="text-sm font-semibold tracking-wide">VantosEdge</span>
          <nav className="flex items-center gap-1 text-xs">
            {NAV.map((n) => (
              <NavLink
                key={n.to}
                to={n.to}
                end={n.end}
                className={({ isActive }) =>
                  `rounded px-2.5 py-1 ${isActive ? "bg-sky-500/20 text-sky-300" : "text-gray-400 hover:bg-white/10 hover:text-gray-200"}`
                }
              >
                {n.label}
              </NavLink>
            ))}
          </nav>
        </div>
        <div className="flex items-center gap-3 text-xs">
          <span className={health.data?.status === "ok" ? "text-emerald-400" : "text-gray-500"}>
            backend: {health.isLoading ? "…" : (health.data?.status ?? "unreachable")}
          </span>
          <button onClick={logout} className="rounded border border-white/10 px-2 py-1 hover:bg-white/10">
            Sign out
          </button>
        </div>
      </header>
      <main className="relative flex-1 overflow-hidden">{children}</main>
    </div>
  );
}
