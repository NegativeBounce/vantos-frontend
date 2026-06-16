import PageShell, { Placeholder } from "../components/PageShell";

export default function ReportsPage() {
  return (
    <PageShell title="Reports" subtitle="Search and review previously generated intelligence reports.">
      {/* Filter bar (placeholder) */}
      <div className="flex flex-wrap items-end gap-3 rounded-lg border border-white/10 bg-black/30 p-4 text-xs">
        {[
          { label: "Region", ph: "All regions" },
          { label: "Report type", ph: "All types" },
          { label: "Date range", ph: "Any time" },
          { label: "Keyword", ph: "Search…" },
        ].map((f) => (
          <label key={f.label} className="flex flex-col gap-1 text-gray-400">
            {f.label}
            <input
              disabled
              placeholder={f.ph}
              className="w-40 rounded-md bg-black/30 px-2 py-1.5 text-gray-300 ring-1 ring-white/10"
            />
          </label>
        ))}
        <button disabled className="rounded-md border border-white/10 px-3 py-1.5 text-gray-500">
          Search
        </button>
      </div>

      {/* Results table (placeholder) */}
      <div className="mt-4 overflow-hidden rounded-lg border border-white/10">
        <table className="w-full text-xs">
          <thead className="bg-white/5 text-gray-400">
            <tr>
              {["Title", "Region", "Type", "Risk", "Created", "Status"].map((h) => (
                <th key={h} className="px-3 py-2 text-left font-medium">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            <tr>
              <td colSpan={6} className="px-3 py-8 text-center text-gray-500">
                No reports yet — generate one from the map workspace, then it'll be searchable here.
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <p className="mt-4 text-[11px] text-gray-600">
        Intent: filterable archive of generated reports (by region, type, date, keyword) with export/share.
        Wires up once the report engine lands.
      </p>
    </PageShell>
  );
}
