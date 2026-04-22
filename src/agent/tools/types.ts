export interface ToolSchema {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: {
      type: 'object';
      properties: Record<string, unknown>;
      required?: string[];
    };
  };
}

export interface ToolContext {
  workspaceRoot: string;
  approve: (toolName: string, args: Record<string, unknown>) => Promise<boolean>;
  log: (msg: string) => void;
}

export interface ToolHandler {
  schema: ToolSchema;
  risky: boolean;
  run: (args: Record<string, unknown>, ctx: ToolContext) => Promise<string>;
}
