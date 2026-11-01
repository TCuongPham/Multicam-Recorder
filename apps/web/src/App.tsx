import { NavLink, Navigate, Outlet, Route, Routes } from 'react-router';
import { useStore } from '@multicam/shared/react';
import { ForgotPage, LoginPage, SignupPage, VerifyPage } from './pages/AuthPages';
import { CameraPage } from './pages/CameraPage';
import { LibraryPage } from './pages/LibraryPage';
import { RemoteLibraryPage } from './pages/RemoteLibraryPage';
import { RoomPage } from './pages/RoomPage';
import { SettingsPage } from './pages/SettingsPage';
import { useSession } from './lib/session';
import type { RemoteRuntime } from './lib/remoteRuntime';

function RecordingDot({ runtime }: { runtime: RemoteRuntime }) {
  const s = useStore(runtime.agent);
  if (s.recordingState !== 'recording') return null;
  return <span className="rec-dot" title="Đang quay" />;
}

function Shell() {
  const { session, runtime } = useSession();
  if (!session) return <Navigate to="/login" replace />;
  const isController = session.role === 'controller';
  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="brand-dot" />
          Multi-Cam
          <span className={`role role-${session.role}`}>{isController ? 'Controller' : 'Remote'}</span>
          {runtime ? <RecordingDot runtime={runtime} /> : null}
        </div>
        <nav className="nav">
          {isController ? (
            <>
              <NavLink to="/room">Điều khiển</NavLink>
              <NavLink to="/library">Thư viện</NavLink>
            </>
          ) : (
            <>
              <NavLink to="/camera">Camera</NavLink>
              <NavLink to="/my-library">Thư viện</NavLink>
            </>
          )}
          <NavLink to="/settings">Cài đặt</NavLink>
        </nav>
      </header>
      <main>
        <Outlet />
      </main>
    </div>
  );
}

function Home() {
  const { session } = useSession();
  if (!session) return <Navigate to="/login" replace />;
  return <Navigate to={session.role === 'controller' ? '/room' : '/camera'} replace />;
}

function RoleRoute({ role, children }: { role: 'controller' | 'remote'; children: React.ReactNode }) {
  const { session } = useSession();
  if (session?.role !== role) return <Navigate to="/" replace />;
  return <>{children}</>;
}

function PublicOnly({ children }: { children: React.ReactNode }) {
  const { session } = useSession();
  return session ? <Navigate to="/" replace /> : <>{children}</>;
}

export function App() {
  return (
    <Routes>
      <Route path="/login" element={<PublicOnly><LoginPage /></PublicOnly>} />
      <Route path="/signup" element={<PublicOnly><SignupPage /></PublicOnly>} />
      <Route path="/verify" element={<PublicOnly><VerifyPage /></PublicOnly>} />
      <Route path="/forgot" element={<PublicOnly><ForgotPage /></PublicOnly>} />
      <Route element={<Shell />}>
        <Route path="/room" element={<RoleRoute role="controller"><RoomPage /></RoleRoute>} />
        <Route path="/library" element={<RoleRoute role="controller"><LibraryPage /></RoleRoute>} />
        <Route path="/camera" element={<RoleRoute role="remote"><CameraPage /></RoleRoute>} />
        <Route path="/my-library" element={<RoleRoute role="remote"><RemoteLibraryPage /></RoleRoute>} />
        <Route path="/settings" element={<SettingsPage />} />
      </Route>
      <Route path="*" element={<Home />} />
    </Routes>
  );
}
