import PageShell, { Placeholder } from "../components/PageShell";

export default function SettingsPage() {
  return (
    <PageShell title="Settings" subtitle="Your account and preferences.">
      <div className="space-y-4">
        <section className="rounded-lg border border-white/10 bg-black/30 p-4">
          <h2 className="text-sm font-medium text-gray-200">Profile</h2>
          <Placeholder>Display name, email, password — account details (read-only for now).</Placeholder>
        </section>
        <section className="rounded-lg border border-white/10 bg-black/30 p-4">
          <h2 className="text-sm font-medium text-gray-200">Preferences</h2>
          <Placeholder>Map defaults (home view, units), theme, and notification preferences will live here.</Placeholder>
        </section>
      </div>
      <p className="mt-4 text-[11px] text-gray-600">
        Intent: per-user settings. Exact options TBD; placeholder so the navigation and intent are visible.
      </p>
    </PageShell>
  );
}
