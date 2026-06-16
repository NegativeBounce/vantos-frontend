import type { ReactNode } from "react";

// Standard scrollable page wrapper for the management surfaces.
export default function PageShell({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle: string;
  children: ReactNode;
}) {
  return (
    <div className="h-full overflow-auto">
      <div className="mx-auto max-w-5xl p-6">
        <h1 className="text-xl font-semibold">{title}</h1>
        <p className="mt-1 text-sm text-gray-400">{subtitle}</p>
        <div className="mt-6">{children}</div>
      </div>
    </div>
  );
}

export function Placeholder({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-lg border border-dashed border-white/15 bg-white/[0.02] p-4 text-xs text-gray-500">
      {children}
    </div>
  );
}
