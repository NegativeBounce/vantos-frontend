import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../lib/auth";

// No sign-up — accounts are provisioned by an administrator (D-32).
export default function Login() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await login(email, password);
      navigate("/", { replace: true });
    } catch (err) {
      setError((err as Error).message || "Login failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex h-full items-center justify-center p-6">
      <form onSubmit={submit} className="w-80 space-y-4 rounded-xl border border-white/10 bg-white/5 p-6">
        <div className="text-lg font-semibold">VantosEdge</div>
        <p className="text-xs text-gray-400">Sign in to your account.</p>
        <input
          className="w-full rounded-md bg-black/30 px-3 py-2 text-sm outline-none ring-1 ring-white/10 focus:ring-sky-500"
          type="email"
          placeholder="Email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          autoComplete="username"
          required
        />
        <input
          className="w-full rounded-md bg-black/30 px-3 py-2 text-sm outline-none ring-1 ring-white/10 focus:ring-sky-500"
          type="password"
          placeholder="Password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="current-password"
          required
        />
        {error && <p className="text-xs text-amber-400">{error}</p>}
        <button
          className="w-full rounded-md bg-sky-600 px-3 py-2 text-sm font-medium hover:bg-sky-500 disabled:opacity-50"
          type="submit"
          disabled={busy}
        >
          {busy ? "Signing in…" : "Sign in"}
        </button>
        <p className="text-center text-[11px] text-gray-500">Accounts are provisioned by an administrator.</p>
      </form>
    </div>
  );
}
