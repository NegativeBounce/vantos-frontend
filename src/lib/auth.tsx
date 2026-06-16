import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { getToken, clearToken, login as apiLogin, setUnauthorizedHandler, type AuthUser } from "./api";

type AuthState = {
  isAuthed: boolean;
  user: AuthUser | null;
  login: (email: string, password: string) => Promise<void>;
  logout: () => void;
};

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [token, setTok] = useState<string | null>(() => getToken());
  const [user, setUser] = useState<AuthUser | null>(null);

  // If any API call returns 401, the token was cleared — drop auth state too.
  useEffect(() => {
    setUnauthorizedHandler(() => {
      setTok(null);
      setUser(null);
    });
    return () => setUnauthorizedHandler(null);
  }, []);

  const login = async (email: string, password: string) => {
    const u = await apiLogin(email, password);
    setTok(getToken());
    setUser(u);
  };
  const logout = () => {
    clearToken();
    setTok(null);
    setUser(null);
  };

  return (
    <AuthContext.Provider value={{ isAuthed: !!token, user, login, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
