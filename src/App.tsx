import { Navigate, Outlet, Route, Routes } from "react-router-dom";
import { useAuth } from "./lib/auth";
import AppLayout from "./components/AppLayout";
import Login from "./pages/Login";
import Workspace from "./pages/Workspace";
import ReportsPage from "./pages/ReportsPage";
import SubscribersPage from "./pages/SubscribersPage";
import AdminPage from "./pages/AdminPage";
import SettingsPage from "./pages/SettingsPage";

function RequireAuth() {
  const { isAuthed } = useAuth();
  if (!isAuthed) return <Navigate to="/login" replace />;
  return (
    <AppLayout>
      <Outlet />
    </AppLayout>
  );
}

export default function App() {
  const { isAuthed } = useAuth();
  return (
    <Routes>
      <Route path="/login" element={isAuthed ? <Navigate to="/" replace /> : <Login />} />
      <Route element={<RequireAuth />}>
        <Route path="/" element={<Workspace />} />
        <Route path="/reports" element={<ReportsPage />} />
        <Route path="/subscribers" element={<SubscribersPage />} />
        <Route path="/admin" element={<AdminPage />} />
        <Route path="/settings" element={<SettingsPage />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
