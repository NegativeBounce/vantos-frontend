import { createContext, useContext, useState, type ReactNode } from "react";

// PLACEHOLDER auth only. There is NO real authentication yet — the backend auth
// system (admin-provisioned accounts, login, sessions/JWT — D-32) is a later slice.
// This just gates the UI locally so we can build the workspace. Do NOT treat as secure.
type AuthState = { isAuthed: boolean; login: () => void; logout: () => void };

const AuthContext = createContext<AuthState | null>(null);
const KEY = "vantos.authed";

export function AuthProvider({ children }: { children: ReactNode }) {
  const [isAuthed, setIsAuthed] = useState(() => localStorage.getItem(KEY) === "1");
  const login = () => {
    localStorage.setItem(KEY, "1");
    setIsAuthed(true);
  };
  const logout = () => {
    localStorage.removeItem(KEY);
    setIsAuthed(false);
  };
  return <AuthContext.Provider value={{ isAuthed, login, logout }}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
