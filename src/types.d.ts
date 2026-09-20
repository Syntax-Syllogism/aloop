/** Shared static contracts for the ESM implementation. These declarations have no runtime output. */

export type Permission = string;
export type PhaseKind = 'agent' | 'gate' | 'publish';
export type PhaseRole = 'verdict' | 'repair';

export interface RetryPolicy {
  maxAttempts: number;
  maxRounds?: number;
}

export interface HermeticConfig {
  runtime?: string;
  image?: string | null;
  network?: string[];
  env?: string[];
  secrets?: string[];
}

export interface PhaseBase {
  name: string;
  kind: PhaseKind;
  inputs: string[];
  outputs: string[];
  postconditions: string[];
  permissions: Permission[];
  optional: boolean;
  requiresCleanTree?: boolean;
  retry: RetryPolicy;
  maxRounds?: number;
  repair?: PhaseDescriptor[];
  recheck?: boolean;
  verdict?: boolean;
  role?: PhaseRole;
  hermetic?: HermeticConfig | null;
}

export interface AgentPhase extends PhaseBase {
  kind: 'agent';
  prompt: string;
}

export interface GatePhase extends PhaseBase {
  kind: 'gate';
  commands?: string[];
}

export interface PublishPhase extends PhaseBase {
  kind: 'publish';
}

export type PhaseDescriptor = AgentPhase | GatePhase | PublishPhase;

export interface Agent {
  name: string;
  model?: string;
  effort?: string;
}

export interface AdapterCommandOptions {
  prompt: string;
  cwd: string;
  addDirs: string[];
  permissions?: Permission[];
  timeoutMs?: number;
  artifactOnly?: boolean;
  agent?: Partial<Agent>;
}

export interface AdapterCommand {
  command: string;
  args: string[];
  [key: string]: unknown;
}

export interface Adapter {
  name?: string;
  efforts?: string[];
  command(options: AdapterCommandOptions): AdapterCommand;
  version?: (options?: { agent?: Engine; cwd?: string }) => Promise<string | undefined>;
  usage?: () => Usage | undefined;
  createRenderer?: () => Renderer;
}

export interface Renderer {
  write(text: string): string;
  end(): string;
  usage?: () => Usage | undefined;
}

export interface Engine extends Agent {}

export interface Budget {
  tokens?: number;
  usd?: number;
  wallClockMs?: number;
}

export interface Config {
  baseBranch: string;
  branchPrefix: string;
  remote: string | null;
  adapters: Record<string, Adapter>;
  engines: Record<string, Engine>;
  phases: Array<string | Partial<PhaseDescriptor>>;
  resolvedPhases: PhaseDescriptor[];
  publish: { backend?: string | object; draft?: boolean };
  gate: string[];
  setup: string[];
  shell: string;
  maxRounds: number;
  timeoutMs: number;
  budget: Budget;
  worktrees: boolean;
  worktreeRoot: string | null;
  promptDir: string;
  runsDir: string;
  hermetic: HermeticConfig;
}

export interface Finding {
  issue?: string;
  summary?: string;
  file?: string;
  line?: number;
  [key: string]: any;
}

export interface Verdict {
  verdict: 'APPROVED' | 'CHANGES_REQUESTED';
  blocking: Finding[];
  nits: Finding[];
  summary: string;
}

export interface Usage {
  tokens?: number;
  cost?: number;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  costUsd?: number;
  [key: string]: unknown;
}

export interface ManifestEntry {
  phase: string;
  status?: 'completed' | 'failed' | 'skipped' | 'stalled';
  startedAt?: string;
  completedAt?: string;
  inputSha?: string;
  outputSha?: string;
  approvedSha?: string;
  usage?: Usage;
  [key: string]: unknown;
}

export interface RunData {
  schemaVersion: number;
  runId: string;
  completed: string[];
  rounds: Record<string, number>;
  reviewedShas: Record<string, string>;
  phases?: Record<string, Record<string, any>>;
  pendingRepairs?: Record<string, any>;
  [key: string]: any;
}

export interface RunState {
  dir: string;
  data: RunData;
  readOnly: boolean;
  manifest: { entries: ManifestEntry[] };
  manifestMetadata: Record<string, any>;
  hasSnapshot(): Promise<boolean>;
  saveSnapshot(snapshot: Record<string, unknown>): Promise<void>;
  logPath(name: string): string;
  verdictPath(round: number): string;
  isComplete(name: string): boolean;
  markComplete(name: string, details?: Record<string, unknown>): Promise<void>;
  record(patch: Record<string, unknown>): Promise<void>;
  saveManifest(manifest: Record<string, unknown>): Promise<void>;
}

export interface Summary {
  phases: Array<Record<string, unknown>>;
  stalled?: { phase: string; reason: string; [key: string]: any } | null;
  branch?: string;
  baseBranch?: string;
  remote?: string;
  worktree?: string;
  runDir?: string;
  task?: string;
  taskFile?: string | null;
  prUrl?: string | null;
  pullRequest?: Record<string, unknown> | null;
}

export interface Operations {
  budgetStatus(ctx: unknown): any;
  markBudgetExhaustedComplete(state: RunState, phase: PhaseDescriptor, details?: Record<string, unknown>): Promise<void>;
  manifestEntry(phase: PhaseDescriptor, ctx: unknown, values?: Partial<ManifestEntry>): ManifestEntry;
  markStalledManifest(ctx: unknown, phase: PhaseDescriptor, result: unknown, startIndex: number): Promise<void>;
  recordBudgetStall(ctx: unknown, phase: PhaseDescriptor, budget: unknown): Promise<Summary['stalled']>;
  recordManifest(ctx: unknown, entry: ManifestEntry): Promise<void>;
  runAgent(phase: AgentPhase, ctx: unknown, variables: Record<string, unknown>): Promise<any>;
  runGate(phase: GatePhase, ctx: unknown): Promise<any>;
  runPublish(phase: PublishPhase, ctx: unknown, values: any): Promise<any>;
  withRetries(phase: PhaseDescriptor, operation: () => Promise<any>, options?: Record<string, unknown>): Promise<any>;
}

declare global {
  interface Error {
    code?: string | number;
    command?: unknown;
    stdout?: string;
    stderr?: string;
    output?: string;
    signal?: string | null;
    timedOut?: boolean;
  }
}

declare module 'node:events' {
  interface EventEmitter {
    pid?: number;
    stdout?: any;
    stderr?: any;
    stdin?: any;
    directlyKilled?: boolean;
    kill?: (...args: any[]) => any;
  }
}

declare module 'node:stream' {
  interface Readable { isTTY?: boolean; }
  interface PassThrough { isTTY?: boolean; }
}
