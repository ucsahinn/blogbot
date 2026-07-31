import type {
  CodexEvent,
  StructuredCodexPort
} from "./structured-runner.ts";

export function createMockStructuredCodexPort(
  events: readonly CodexEvent[]
): StructuredCodexPort {
  return {
    async *run() {
      yield* events;
    }
  };
}
