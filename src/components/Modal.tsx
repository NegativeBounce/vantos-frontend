import type { ReactNode } from "react";

// Floating center modal. By default NON-blocking: no dark backdrop and clicks
// outside pass through to the map (so map tools stay usable). Set blocking for
// focused actions (e.g. report generation).
export default function Modal({
  title,
  onClose,
  children,
  blocking = false,
  width = "w-96",
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  blocking?: boolean;
  width?: string;
}) {
  return (
    <div
      className={`absolute inset-0 z-30 flex items-center justify-center p-4 ${blocking ? "bg-black/50" : "pointer-events-none"}`}
      onClick={blocking ? onClose : undefined}
    >
      <div
        className={`pointer-events-auto ${width} rounded-xl border border-white/10 bg-[#0f1620]/95 p-5 text-sm shadow-2xl`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <div className="text-base font-semibold">{title}</div>
          <button onClick={onClose} className="text-gray-400 hover:text-white">✕</button>
        </div>
        <div className="mt-3">{children}</div>
      </div>
    </div>
  );
}
