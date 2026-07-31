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
  | "PAID_FALLBACK_DISABLED";

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
}

/**
 * The queue adapter must deduplicate by idempotencyKey + generation.
 * Calling this method again is how the coordinator safely repairs a dispatch
 * that may have failed after the durable reservation was committed.
 */
export interface CodexJobQueuePort {
  enqueueOnce(message: CodexQueueMessage): Promise<void>;
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
}

export interface CodexWorkerCoordinatorDependencies {
  persistence: CodexJobPersistencePort;
  queue: CodexJobQueuePort;
  taskResolver: CodexTaskResolverPort;
  codex: StructuredCodexPort;
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
  const { persistence, queue, taskResolver, codex, onCompleted } = dependencies;

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
      try {
        const task = await taskResolver.resolve(running);
        if (task.paidFallbackRequested === true) {
          const selection = resolveCodexRole(task.taskKind, task.roleModels);
          return await persistence.markWaiting({
            jobId: running.jobId,
            expectedVersion: running.version,
            reason: "PAID_FALLBACK_DISABLED",
            ...selection
          });
        }

        const result = await runStructuredCodexTask(task, codex);
        if (result.status === "WAITING_CODEX") {
          return await persistence.markWaiting({
            jobId: running.jobId,
            expectedVersion: running.version,
            reason: result.reason,
            role: result.role,
            model: result.model
          });
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
        const queued = await persistence.returnToQueued({
          jobId: running.jobId,
          expectedVersion: running.version,
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
    }
  };
}
