import type { OperatorIdentity } from '@cadentor/shared';
import { createContext, useContext } from 'react';

export interface OperatorSession {
  operator: OperatorIdentity;
  signOut: () => void;
}

export const OperatorSessionContext = createContext<OperatorSession | null>(null);

/** The signed-in operator. Only usable inside AuthGate. */
export function useOperatorSession(): OperatorSession {
  const session = useContext(OperatorSessionContext);
  if (session === null) throw new Error('useOperatorSession must be used inside AuthGate');
  return session;
}
