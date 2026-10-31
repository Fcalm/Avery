import type { ApplicationState, Goal, Profile, ParserConfig } from './client.cjs';
export const definitions: Array<{ id: string; title: string; profile: Profile }>;
export function createScenario(id?: string, goal?: Goal, seed?: number, parserOverride?: ParserConfig): {
  id: string; version: string; hash: string; inputHash: string; input: string; expected: ApplicationState; initial: ApplicationState;
};
