import { useQuery } from "@tanstack/react-query";
import PageShell, { Placeholder } from "../components/PageShell";
import { getDataSources } from "../lib/api";

export default function AdminPage() {
  const sources = useQuery({ queryKey: ["dataSources"], queryFn: getDataSources });

  return (
    <PageShell title="Admin" subtitle="Manage users and invitations, data APIs, and integrations.">
      {/* Users */}
      <section className="rounded-lg border border-white/10 bg-black/30 p-4">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-medium text-gray-200">Users</h2>
          <button disabled className="rounded-md border border-white/10 px-2 py-1 text-xs text-gray-500">Invite user</button>
        </div>
        <Placeholder>
          Admin-provisioned accounts only (no public sign-up). Invite users and manage roles here.
        </Placeholder>
      </section>

      {/* Data APIs & integrations — live from the backend */}
      <section className="mt-4 rounded-lg border border-white/10 bg-black/30 p-4">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-medium text-gray-200">Data APIs & integrations</h2>
          <button disabled className="rounded-md border border-white/10 px-2 py-1 text-xs text-gray-500">Add API</button>
        </div>
        <div className="mt-3 overflow-hidden rounded-md border border-white/10">
          <table className="w-full text-xs">
            <thead className="bg-white/5 text-gray-400">
              <tr>
                {["Name", "Provider", "Auth", "Key", "Status"].map((h) => (
                  <th key={h} className="px-3 py-2 text-left font-medium">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody className="text-gray-300">
              {sources.data?.dataSources?.map((s) => (
                <tr key={s.id} className="border-t border-white/5">
                  <td className="px-3 py-2">{s.name}</td>
                  <td className="px-3 py-2 text-gray-400">{s.provider}</td>
                  <td className="px-3 py-2 text-gray-400">{s.authType}</td>
                  <td className="px-3 py-2 font-mono text-gray-400">{s.keyHint ?? "—"}</td>
                  <td className="px-3 py-2"><span className="text-emerald-400">{s.status}</span></td>
                </tr>
              ))}
              {!sources.data?.dataSources?.length && (
                <tr><td colSpan={5} className="px-3 py-6 text-center text-gray-500">
                  {sources.isLoading ? "Loading…" : "No data sources configured."}
                </td></tr>
              )}
            </tbody>
          </table>
        </div>
        <p className="mt-2 text-[11px] text-gray-600">
          Keys are stored encrypted server-side (only a masked hint is shown). Adding/editing keys wires up next.
        </p>
      </section>
    </PageShell>
  );
}
