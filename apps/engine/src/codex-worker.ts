import {
  runStructuredCodexTask,
  type StructuredCodexPort,
  type StructuredCodexTask
} from "../../codex-runner/src/structured-runner.ts";
import {
  resolveCodexRole,
  type CodexLogicalRole
} from "../../codex-runner/src/role-policy.ts";

export type CodexWaitReason =
  | "AUTH_REQUIRED"
  | "RATE_LIMIT"
  | "USAGE_LIMIT"
  | "PAID_FALLBACK_DISABLED"
  | "RUNNER_TIMEOUT"
  | "RUNNER_REQUIRES_RETRY";

export type CodexRunnerDiagnosticCode =
  | "CODEX_PROTOCOL_REJECTED"
  | "CODEX_OUTPUT_INVALID"
  | "CODEX_OUTPUT_MISSING"
  | "CODEX_CLI_INVALID_EVENT"
  | "CODEX_CLI_INVALID_FINAL_OUTPUT"
  | "CODEX_PROCESS_FAILED"
  | "CODEX_UNKNOWN_FAILURE";

export interface CodexWorkSubmission {
  jobId: string;
  idempotencyKey: string;
  definitionId: string;
  payload: unknown;
}

interface CodexJobBase extends CodexWorkSubmission {
  version: number;
}

export type CodexJobSnapshot =
  | (CodexJobBase & {
      state: "QUEUED";
      lastFailure?: "EXECUTION_FAILED";
    })
  | (CodexJobBase & {
      state: "RUNNING";
    })
  | (CodexJobBase & {
      state: "WAITING_CODEX";
      reason: CodexWaitReason;
      role: CodexLogicalRole;
      model: string;
    })
  | (CodexJobBase & {
      state: "COMPLETED";
      role: CodexLogicalRole;
      model: string;
      output: unknown;
    });

export interface CodexQueueMessage {
  jobId: string;
  idempotencyKey: string;
  generation: number;
}

export interface CodexJobPersistencePort {
  reserveQueued(
    submission: CodexWorkSubmission
  ): Promise<{ created: boolean; snapshot: CodexJobSnapshot }>;
  claimQueued(
    message: CodexQueueMessage
  ): Promise<{ claimed: boolean; snapshot: CodexJobSnapshot }>;
  markWaiting(input: {
    jobId: string;
    expectedVersion: number;
    reason: CodexWaitReason;
    role: CodexLogicalRole;
    model: string;
  }): Promise<CodexJobSnapshot>;
  markCompleted(input: {
    jobId: string;
    expectedVersion: number;
    role: CodexLogicalRole;
    model: string;
    output: unknown;
  }): Promise<CodexJobSnapshot>;
  returnToQueued(input: {
    jobId: string;
    expectedVersion: number;
    failure: "EXECUTION_FAILED";
  }): Promise<CodexJobSnapshot>;
  requeueWaiting(
    message: CodexQueueMessage
  ): Promise<{ requeued: boolean; snapshot: CodexJobSnapshot }>;
  recoverInterrupted(jobId: string): Promise<{
    recovered: boolean;
    snapshot: CodexJobSnapshot | null;
    interruptedQueueGeneration?: number;
  }>;
}

/**
 * The queue adapter must deduplicate by idempotencyKey + generation.
 * Calling this method again is how the coordinator safely repairs a dispatch
 * that may have failed after the durable reservation was committed.
 */
export interface CodexJobQueuePort {
  enqueueOnce(message: CodexQueueMessage): Promise<void>;
  recoverInterrupted?(message: CodexQueueMessage): Promise<void>;
}

export interface CodexTaskResolverPort {
  resolve(
    snapshot: Extract<CodexJobSnapshot, { state: "RUNNING" }>
  ):
    | StructuredCodexTask<unknown>
    | Promise<StructuredCodexTask<unknown>>;
}

export interface CodexWorkerCoordinator {
  submit(submission: CodexWorkSubmission): Promise<CodexJobSnapshot>;
  process(message: CodexQueueMessage): Promise<CodexJobSnapshot>;
  retryWaiting(message: CodexQueueMessage): Promise<CodexJobSnapshot>;
  recoverInterrupted(jobId: string): Promise<{
    recovered: boolean;
    snapshot: CodexJobSnapshot | null;
    interruptedQueueGeneration?: number;
  }>;
}

export interface CodexWorkerCoordinatorDependencies {
  persistence: CodexJobPersistencePort;
  queue: CodexJobQueuePort;
  taskResolver: CodexTaskResolverPort;
  codex: StructuredCodexPort;
  onStarted?: (input: {
    submission: CodexWorkSubmission;
  }) => Promise<void>;
  onTaskReady?: (input: {
    submission: CodexWorkSubmission;
  }) => Promise<void>;
  onWaiting?: (input: {
    submission: CodexWorkSubmission;
    reason: CodexWaitReason;
    diagnosticCode?: CodexRunnerDiagnosticCode;
  }) => Promise<void>;
  onRetrying?: (input: {
    submission: CodexWorkSubmission;
    failure: "EXECUTION_FAILED";
  }) => Promise<void>;
  onCompleted?: (input: {
    submission: CodexWorkSubmission;
    role: CodexLogicalRole;
    model: string;
    output: unknown;
  }) => Promise<void>;
}

function queueMessage(snapshot: CodexJobSnapshot): CodexQueueMessage {
  return {
    jobId: snapshot.jobId,
    idempotencyKey: snapshot.idempotencyKey,
    generation: snapshot.version
  };
}

export function createCodexWorkerCoordinator(
  dependencies: CodexWorkerCoordinatorDependencies
): CodexWorkerCoordinator {
  const { persistence, queue, taskResolver, codex, onStarted, onTaskReady, onWaiting, onRetrying, onCompleted } = dependencies;

  return {
    async submit(submission) {
      const reservation = await persistence.reserveQueued(submission);
      if (reservation.snapshot.state === "QUEUED") {
        await queue.enqueueOnce(queueMessage(reservation.snapshot));
      }
      return reservation.snapshot;
    },

    async process(message) {
      const claim = await persistence.claimQueued(message);
      if (!claim.claimed) {
        return claim.snapshot;
      }
      if (claim.snapshot.state !== "RUNNING") {
        throw new Error("persistence returned a non-running claimed Codex job");
      }

      const running = claim.snapshot;
      let taskSelection: ReturnType<typeof resolveCodexRole> | undefined;
      try {
        await onStarted?.({
          submission: {
            jobId: running.jobId,
            idempotencyKey: running.idempotencyKey,
            definitionId: running.definitionId,
            payload: running.payload
          }
        });
        const task = await taskResolver.resolve(running);
        taskSelection = resolveCodexRole(task.taskKind, task.roleModels);
        await onTaskReady?.({
          submission: { jobId: running.jobId, idempotencyKey: running.idempotencyKey, definitionId: running.definitionId, payload: running.payload }
        });
        if (task.paidFallbackRequested === true) {
          const selection = resolveCodexRole(task.taskKind, task.roleModels);
          const waiting = await persistence.markWaiting({
            jobId: running.jobId,
            expectedVersion: running.version,
            reason: "PAID_FALLBACK_DISABLED",
            ...selection
          });
          await onWaiting?.({
            submission: { jobId: running.jobId, idempotencyKey: running.idempotencyKey, definitionId: running.definitionId, payload: running.payload },
            reason: "PAID_FALLBACK_DISABLED"
          });
          return waiting;
        }

        const result = await runStructuredCodexTask(task, codex);
        if (result.status === "WAITING_CODEX") {
          const waiting = await persistence.markWaiting({
            jobId: running.jobId,
            expectedVersion: running.version,
            reason: result.reason,
            role: result.role,
            model: result.model
          });
          await onWaiting?.({
            submission: { jobId: running.jobId, idempotencyKey: running.idempotencyKey, definitionId: running.definitionId, payload: running.payload },
            reason: result.reason
          });
          return waiting;
        }

        const completed = await persistence.markCompleted({
          jobId: running.jobId,
          expectedVersion: running.version,
          role: result.role,
          model: result.model,
          output: result.output
        });
        await onCompleted?.({
          submission: {
            jobId: running.jobId,
            idempotencyKey: running.idempotencyKey,
            definitionId: running.definitionId,
            payload: running.payload
          },
          role: result.role,
          model: result.model,
          output: result.output
        });
        return completed;
      } catch (error) {
        if (isRunnerTimeout(error)) {
          if (!taskSelection) throw error;
          const waiting = await persistence.markWaiting({
            jobId: running.jobId,
            expectedVersion: running.version,
            reason: "RUNNER_TIMEOUT",
            ...taskSelection
          });
          await onWaiting?.({
            submission: { jobId: running.jobId, idempotencyKey: running.idempotencyKey, definitionId: running.definitionId, payload: running.payload },
            reason: "RUNNER_TIMEOUT"
          });
          return waiting;
        }
        if (isTerminalRunnerFailure(error)) {
          if (!taskSelection) throw error;
          const diagnosticCode = runnerDiagnosticCode(error);
          const waiting = await persistence.markWaiting({
            jobId: running.jobId,
            expectedVersion: running.version,
            reason: "RUNNER_REQUIRES_RETRY",
            ...taskSelection
          });
          await onWaiting?.({
            submission: { jobId: running.jobId, idempotencyKey: running.idempotencyKey, definitionId: running.definitionId, payload: running.payload },
            reason: "RUNNER_REQUIRES_RETRY",
            diagnosticCode
          });
          return waiting;
        }
        const queued = await persistence.returnToQueued({
          jobId: running.jobId,
          expectedVersion: running.version,
          failure: "EXECUTION_FAILED"
        });
        await onRetrying?.({
          submission: { jobId: running.jobId, idempotencyKey: running.idempotencyKey, definitionId: running.definitionId, payload: running.payload },
          failure: "EXECUTION_FAILED"
        });
        await queue.enqueueOnce(queueMessage(queued));
        throw error;
      }
    },

    async retryWaiting(message) {
      const result = await persistence.requeueWaiting(message);
      if (result.snapshot.state === "QUEUED") {
        await queue.enqueueOnce(queueMessage(result.snapshot));
      }
      return result.snapshot;
    },

    async recoverInterrupted(jobId) {
      const result = await persistence.recoverInterrupted(jobId);
      if (result.snapshot?.state === "QUEUED") {
        // The durable Codex record can already be QUEUED while pg-boss still
        // holds the matching message ACTIVE from a terminated sidecar. Recover
        // that reservation before enqueueing: otherwise idempotent enqueue
        // observes the stale ACTIVE record and the draft remains stuck forever.
        await queue.recoverInterrupted?.({
          jobId: result.snapshot.jobId,
          idempotencyKey: result.snapshot.idempotencyKey,
          generation: result.interruptedQueueGeneration ?? result.snapshot.version
        });
      }
      if (result.snapshot?.state === "QUEUED") {
        await queue.enqueueOnce(queueMessage(result.snapshot));
      }
      return result;
    }
  };
}

function isRunnerTimeout(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "PROCESS_TIMEOUT";
}

function isTerminalRunnerFailure(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) return false;
  return ["DENIED_EVENT", "INVALID_OUTPUT", "MISSING_OUTPUT", "INVALID_EVENT", "INVALID_FINAL_OUTPUT", "PROCESS_FAILED"].includes(
    String((error as { code?: unknown }).code)
  );
}

function runnerDiagnosticCode(error: unknown): CodexRunnerDiagnosticCode {
  const code = typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code)
    : "";
  switch (code) {
    case "DENIED_EVENT": return "CODEX_PROTOCOL_REJECTED";
    case "INVALID_OUTPUT": return "CODEX_OUTPUT_INVALID";
    case "MISSING_OUTPUT": return "CODEX_OUTPUT_MISSING";
    case "INVALID_EVENT": return "CODEX_CLI_INVALID_EVENT";
    case "INVALID_FINAL_OUTPUT": return "CODEX_CLI_INVALID_FINAL_OUTPUT";
    case "PROCESS_FAILED": return "CODEX_PROCESS_FAILED";
    default: return "CODEX_UNKNOWN_FAILURE";
  }
}
