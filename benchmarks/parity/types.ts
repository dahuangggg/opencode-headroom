export type ParityKind =
  | "json"
  | "search"
  | "log"
  | "text"
  | "code"
  | "diff"
  | "table"
  | "html"
  | "mixed";

export interface ParityFixture {
  id: string;
  kind: ParityKind;
  tool: string;
  query: string;
  content: string;
  protectedFacts: string[];
}

export interface ParityOracleFixture {
  id: string;
  fixtureSha256: string;
  strategy: string;
  originalTokens: number;
  outputTokens: number;
  outputSha256: string;
  structureValid: boolean;
  protectedFacts: string[];
  retainedFacts: string[];
}

export interface ParityOracleSnapshot {
  schemaVersion: 1;
  generatedAt: string;
  reference: {
    package: "headroom-ai";
    version: "0.31.0";
    commit: string;
    profile: string;
    routerConfig: Record<string, boolean | number | string>;
    contentRouterSha256: string;
  };
  fixtures: ParityOracleFixture[];
}
