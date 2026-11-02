import type { useAuthentication } from './authentication.composable';

export type AuthField = 'displayName' | 'email' | 'password';
export type AuthMode = 'login' | 'register';
export interface AuthenticationOptions {
  onAuthenticated: () => void;
}
export type AuthenticationController = ReturnType<typeof useAuthentication>;
export interface AuthenticationPageProps {
  authentication: AuthenticationController;
}
