import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import PageShell from "../components/PageShell";
import { getDataSources, listUsers, createUser, getIngestionRuns } from "../lib/api";

function fmtTime(s: string | null): string {
  if (!s) return "—";
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleString();
}

const ROLES = ["admin", "analyst", "viewer"];

export default function AdminPage() {
  const qc = useQueryClient();
  const sources = useQuery({ queryKey: ["dataSources"], queryFn: getDataSources });
  const users = useQuery({ queryKey: ["users"], queryFn: listUsers });
  const runs = useQuery({ queryKey: ["ingestionRuns"], queryFn: () => getIngestionRuns(25), refetchInterval: 30000 });

  const [mode, setMode] = useState<"manual" | "invite">("manual");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState("analyst");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<null | { name: string; email: string; password: string | null; role: string; invited: boolean }>(null);
  const [copied, setCopied] = useState(false);

  async function submit() {
    setBusy(true);
    setError(null);
    setCreated(null);
    setCopied(false);
    try {
      await createUser({
        email,
        name,
        role,
        password: mode === "manual" ? password : undefined,
        invite: mode === "invite",
      });
      setCreated({ name, email, password: mode === "manual" ? password : null, role, invited: mode === "invite" });
      setName(""); setEmail(""); setPassword("");
      await qc.invalidateQueries({ queryKey: ["users"] });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function copyAll() {
    if (!created) return;
    const url = window.location.origin;
    const lines = [
      "VantosEdge — your account",
      `URL: ${url}`,
      `Name: ${created.name || "—"}`,
      `Email: ${created.email}`,
      ...(created.password ? [`Password: ${created.password}`] : []),
      `Role: ${created.role}`,
      "",
      created.password ? "Sign in at the URL above with these credentials." : "You've been invited — sign-in details to follow.",
    ];
    navigator.clipboard.writeText(lines.join("\n")).then(() => setCopied(true));
  }

  return (
    <PageShell title="Admin" subtitle="Manage users and invitations, data APIs, and integrations.">
      {/* Users */}
      <section className="rounded-lg border border-white/10 bg-black/30 p-4">
        <h2 className="text-sm font-medium text-gray-200">Users</h2>

        {/* Existing users */}
        <div className="mt-3 overflow-hidden rounded-md border border-white/10">
          <table className="w-full text-xs">
            <thead className="bg-white/5 text-gray-400">
              <tr>{["Email", "Name", "Role", "Status"].map((h) => <th key={h} className="px-3 py-2 text-left font-medium">{h}</th>)}</tr>
            </thead>
            <tbody className="text-gray-300">
              {users.data?.users?.map((u) => (
                <tr key={u.id} className="border-t border-white/5">
                  <td className="px-3 py-2">{u.email}</td>
                  <td className="px-3 py-2 text-gray-400">{u.name ?? "—"}</td>
                  <td className="px-3 py-2 text-gray-400">{u.role}</td>
                  <td className="px-3 py-2"><span className={u.status === "active" ? "text-emerald-400" : "text-amber-400"}>{u.status}</span></td>
                </tr>
              ))}
              {!users.data?.users?.length && (
                <tr><td colSpan={4} className="px-3 py-6 text-center text-gray-500">{users.isLoading ? "Loading…" : "No users yet."}</td></tr>
              )}
            </tbody>
          </table>
        </div>

        {/* Create user */}
        <div className="mt-4 rounded-md border border-white/10 bg-black/20 p-3">
          <div className="mb-3 flex gap-2 text-xs">
            <button onClick={() => setMode("manual")} className={`rounded px-2.5 py-1 ${mode === "manual" ? "bg-sky-500/20 text-sky-300" : "text-gray-400 hover:bg-white/10"}`}>Manual add</button>
            <button onClick={() => setMode("invite")} className={`rounded px-2.5 py-1 ${mode === "invite" ? "bg-sky-500/20 text-sky-300" : "text-gray-400 hover:bg-white/10"}`}>Invite by email</button>
          </div>
          <div className="grid gap-2 text-xs sm:grid-cols-2">
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Full name" className="rounded-md bg-black/30 px-2 py-1.5 ring-1 ring-white/10" />
            <input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="Email" type="email" className="rounded-md bg-black/30 px-2 py-1.5 ring-1 ring-white/10" />
            {mode === "manual" && (
              <input value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Password" type="text" className="rounded-md bg-black/30 px-2 py-1.5 ring-1 ring-white/10" />
            )}
            <select value={role} onChange={(e) => setRole(e.target.value)} className="rounded-md bg-black/30 px-2 py-1.5 ring-1 ring-white/10">
              {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
            </select>
          </div>
          {error && <p className="mt-2 text-xs text-amber-400">{error}</p>}
          <button
            onClick={submit}
            disabled={busy || !email || (mode === "manual" && !password)}
            className="mt-3 rounded-md bg-sky-600 px-3 py-1.5 text-xs font-medium hover:bg-sky-500 disabled:opacity-50"
          >
            {busy ? "Saving…" : mode === "manual" ? "Create user" : "Send invite"}
          </button>
          {mode === "invite" && <span className="ml-2 text-[11px] text-gray-500">(no email service yet — copy the details to share manually)</span>}

          {created && (
            <div className="mt-3 rounded-md border border-emerald-500/30 bg-emerald-500/5 p-3 text-xs">
              <div className="mb-1 font-medium text-emerald-400">{created.invited ? "Invited" : "User created"}</div>
              <pre className="whitespace-pre-wrap text-gray-300">
{`URL: ${window.location.origin}
Name: ${created.name || "—"}
Email: ${created.email}${created.password ? `\nPassword: ${created.password}` : ""}
Role: ${created.role}`}
              </pre>
              <button onClick={copyAll} className="mt-2 rounded border border-white/10 px-2 py-1 hover:bg-white/10">
                {copied ? "Copied ✓" : "Copy all"}
              </button>
            </div>
          )}
        </div>
      </section>

      {/* Data APIs & integrations */}
      <section className="mt-4 rounded-lg border border-white/10 bg-black/30 p-4">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-medium text-gray-200">Data APIs & integrations</h2>
          <button disabled className="rounded-md border border-white/10 px-2 py-1 text-xs text-gray-500">Add API</button>
        </div>
        <div className="mt-3 overflow-hidden rounded-md border border-white/10">
          <table className="w-full text-xs">
            <thead className="bg-white/5 text-gray-400">
              <tr>{["Name", "Provider", "Auth", "Key", "Status"].map((h) => <th key={h} className="px-3 py-2 text-left font-medium">{h}</th>)}</tr>
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
                <tr><td colSpan={5} className="px-3 py-6 text-center text-gray-500">{sources.isLoading ? "Loading…" : "No data sources configured."}</td></tr>
              )}
            </tbody>
          </table>
        </div>
        <p className="mt-2 text-[11px] text-gray-600">Keys are stored encrypted server-side (only a masked hint is shown). Adding/editing keys wires up next.</p>
      </section>

      {/* Data Docked usage / credit spend */}
      <section className="mt-4 rounded-lg border border-white/10 bg-black/30 p-4">
        <h2 className="text-sm font-medium text-gray-200">Data Docked usage (measured credit spend)</h2>

        {/* 24h summary per endpoint */}
        <div className="mt-3 flex flex-wrap gap-2">
          {runs.data?.summary?.map((s) => (
            <div key={s.endpoint} className="rounded-md border border-white/10 bg-black/20 px-3 py-2 text-xs">
              <div className="font-mono text-gray-300">{s.endpoint}</div>
              <div className="text-gray-500">
                <span className="text-amber-400">{s.credits_spent}</span> credits · {s.runs} run{s.runs === 1 ? "" : "s"} · {s.records} rec · 24h
              </div>
            </div>
          ))}
          {!runs.data?.summary?.length && (
            <p className="text-xs text-gray-500">{runs.isLoading ? "Loading…" : "No paid Data Docked calls in the last 24h."}</p>
          )}
        </div>

        {/* Recent runs */}
        <div className="mt-3 overflow-hidden rounded-md border border-white/10">
          <table className="w-full text-xs">
            <thead className="bg-white/5 text-gray-400">
              <tr>{["When", "Endpoint", "Region", "Status", "Records", "Spent"].map((h) => <th key={h} className="px-3 py-2 text-left font-medium">{h}</th>)}</tr>
            </thead>
            <tbody className="text-gray-300">
              {runs.data?.runs?.map((r) => (
                <tr key={r.id} className="border-t border-white/5">
                  <td className="px-3 py-2 text-gray-400">{fmtTime(r.finished_at ?? r.started_at)}</td>
                  <td className="px-3 py-2 font-mono">{r.endpoint}</td>
                  <td className="px-3 py-2 text-gray-400">{r.region_name ?? "—"}</td>
                  <td className="px-3 py-2"><span className={r.status === "success" ? "text-emerald-400" : r.status === "error" ? "text-amber-400" : "text-gray-400"}>{r.status}</span></td>
                  <td className="px-3 py-2 text-gray-400">{r.records}</td>
                  <td className="px-3 py-2 font-mono text-amber-400">{r.credits_spent != null ? r.credits_spent : "—"}</td>
                </tr>
              ))}
              {!runs.data?.runs?.length && (
                <tr><td colSpan={6} className="px-3 py-6 text-center text-gray-500">{runs.isLoading ? "Loading…" : "No ingestion runs yet."}</td></tr>
              )}
            </tbody>
          </table>
        </div>
        <p className="mt-2 text-[11px] text-gray-600">Spend is measured from the Data Docked credit balance before/after each paid call. "—" means the balance wasn't readable at the time.</p>
      </section>
    </PageShell>
  );
}
