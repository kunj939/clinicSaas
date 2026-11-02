import { Navigate } from 'react-router-dom';
import { homePathFor, useAuth } from '../auth/AuthContext';

/** `/app` has no content of its own; send each role to its working screen. */
export function HomeRedirect() {
  const { user, clinic } = useAuth();
  if (!user) return <Navigate to="/login" replace />;
  return <Navigate to={homePathFor(user, clinic)} replace />;
}
