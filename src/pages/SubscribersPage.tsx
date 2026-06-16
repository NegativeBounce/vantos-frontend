import PageShell, { Placeholder } from "../components/PageShell";

export default function SubscribersPage() {
  return (
    <PageShell
      title="Subscribers"
      subtitle="Manage subscribers and groups, share reports, and invite people to subscribe."
    >
      <div className="grid gap-4 md:grid-cols-2">
        <section className="rounded-lg border border-white/10 bg-black/30 p-4">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-medium text-gray-200">Subscribers</h2>
            <div className="flex gap-2">
              <button disabled className="rounded-md border border-white/10 px-2 py-1 text-xs text-gray-500">Add</button>
              <button disabled className="rounded-md border border-white/10 px-2 py-1 text-xs text-gray-500">Invite</button>
            </div>
          </div>
          <Placeholder>No subscribers yet. Add people or send subscribe invites here; assign them to regions/report types.</Placeholder>
        </section>

        <section className="rounded-lg border border-white/10 bg-black/30 p-4">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-medium text-gray-200">Groups (by organization)</h2>
            <button disabled className="rounded-md border border-white/10 px-2 py-1 text-xs text-gray-500">New group</button>
          </div>
          <Placeholder>No groups yet. Group subscribers by organization to share reports with a whole team at once.</Placeholder>
        </section>
      </div>

      <p className="mt-4 text-[11px] text-gray-600">
        Intent: manage subscribers + org groups, send subscribe invites, and target report delivery to people or groups.
      </p>
    </PageShell>
  );
}
