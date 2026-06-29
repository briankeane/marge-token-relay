import type { ConsentParams } from './google.js';

export type SessionStatus = 'pending' | 'complete';

export interface SessionRecord {
  consent: ConsentParams;
  pickupHash: string;
  botPublicKey: string;
  status: SessionStatus;
  sealedCode?: string;
  error?: string;
  createdAt: number;
}

export const sessionKey = (id: string): string => `session:${id}`;
export const stateKey = (state: string): string => `state:${state}`;
