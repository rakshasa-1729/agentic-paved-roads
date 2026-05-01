export interface Item {
  name: string;
  source: string;
  title?: string;
  description?: string;
  uri?: string;
  content_type?: string;
  content?: string;
  metadata?: Record<string, unknown>;
}

export interface Source {
  readonly id: string;
  list(query?: string): Promise<Item[]>;
  get(name: string): Promise<Item>;
}

export interface ToolEntry {
  name: string;
  source: string;
  description?: string;
  input_schema?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

export interface ToolInvokeResult {
  ok: boolean;
  stdout?: string;
  stderr?: string;
  exit_code?: number;
  status?: number;
  data?: unknown;
  error?: string;
}

export interface ToolSource {
  readonly id: string;
  list(query?: string): Promise<ToolEntry[]>;
  describe(name: string): Promise<ToolEntry>;
  invoke(name: string, input: unknown): Promise<ToolInvokeResult>;
}
