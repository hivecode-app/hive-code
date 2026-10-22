import type { ClaudeProcess } from './claude-process.ts';

/** Process surface used by shift-host; independent of the provider's transport. */
export type WorkerProcess = Pick<ClaudeProcess,
  'pid' | 'procStart' | 'failureReason' | 'exited' | 'stderrTail' |
  'sendUser' | 'interrupt' | 'usage' | 'contextUsage' | 'stop'>;
