import {
  type EngineAutomationSettingsV1,
  type EngineCommandErrorV1,
  type EngineCommandResultV1,
  type EngineCommandSuccessV1,
  validateEngineCommandV1
} from "../../../packages/contracts/src/index.ts";
import {
  BackendStoreError,
  type BackendRepository
} from "../../../packages/database/src/backend-repository.ts";
import {
  InMemoryLocalPersistence,
  type LocalPersistencePort
} from "../../../packages/database/src/local-persistence.ts";
import { assertValidAutomationSettings } from "../../../packages/editorial/src/automation.ts";
import { canonicalJson } from "../../../packages/editorial/src/revision.ts";

export interface LocalEngineCheckpoint {
  version: 1;
  lastRequestId: string;
  lastSequence: number;
}

export class InMemoryLocalEngineCheckpointStore
  extends InMemoryLocalPersistence<LocalEngineCheckpoint>
{}

export interface LocalEngineOptions {
  repository: BackendRepository;
  checkpoints?: LocalPersistencePort<LocalEngineCheckpoint>;
}

export class LocalEngine {
  private readonly checkpoints: LocalPersistencePort<LocalEngineCheckpoint>;

  constructor(private readonly options: LocalEngineOptions) {
    this.checkpoints = options.checkpoints ?? new InMemoryLocalEngineCheckpointStore();
  }

  async execute(
    input: unknown
  ): Promise<EngineCommandResultV1<EngineAutomationSettingsV1>> {
    const validation = validateEngineCommandV1(input);
    if (!validation.valid) {
      return this.failure(validation.error);
    }
    const command = validation.command;
    if (command.kind !== "AUTOMATION.SET") {
      return this.failure({
        code: "INVALID_COMMAND",
        message: `${command.kind} is handled by a dedicated local engine capability`,
        retryable: false
      });
    }
    try {
      assertValidAutomationSettings(command.payload.settings);
      const result = await this.options.repository.runIdempotent(
        `engine:${command.idempotencyKey}`,
        canonicalJson({ kind: command.kind, payload: command.payload }),
        async (transaction) => {
          const currentVersion = await transaction.getVersion();
          if (currentVersion !== command.expectedVersion) {
            throw new EngineVersionConflictError(
              command.expectedVersion,
              currentVersion
            );
          }
          await transaction.setAutomation(command.payload.settings);
          return {
            ok: true,
            version: 1,
            requestId: command.requestId,
            idempotencyKey: command.idempotencyKey,
            kind: command.kind,
            sequence: await transaction.getVersion(),
            value: await transaction.getAutomation()
          } satisfies EngineCommandSuccessV1<EngineAutomationSettingsV1>;
        }
      );
      await this.writeCheckpoint({
        version: 1,
        lastRequestId: result.requestId,
        lastSequence: result.sequence
      });
      return result;
    } catch (error) {
      if (error instanceof BackendStoreError) {
        return this.failure({
          code:
            error.code === "IDEMPOTENCY_KEY_REUSED"
              ? "IDEMPOTENCY_KEY_REUSED"
              : "ENGINE_OPERATION_FAILED",
          message: error.message,
          retryable: false
        });
      }
      if (error instanceof EngineVersionConflictError) {
        return this.failure({
          code: "VERSION_CONFLICT",
          message: error.message,
          retryable: true
        });
      }
      if (error instanceof Error) {
        return this.failure({
          code: "INVALID_COMMAND",
          message: error.message,
          retryable: false
        });
      }
      return this.failure({
        code: "ENGINE_OPERATION_FAILED",
        message: "Local engine operation failed",
        retryable: true
      });
    }
  }

  private failure(error: EngineCommandErrorV1): EngineCommandResultV1<never> {
    return { ok: false, version: 1, error };
  }

  private async writeCheckpoint(checkpoint: LocalEngineCheckpoint): Promise<void> {
    try {
      await this.checkpoints.write(checkpoint);
    } catch {
      // Checkpoints are only local recovery hints. The repository remains authoritative.
    }
  }
}

class EngineVersionConflictError extends Error {
  constructor(expectedVersion: number, actualVersion: number) {
    super(
      `Expected engine version ${expectedVersion}, but current version is ${actualVersion}`
    );
    this.name = "EngineVersionConflictError";
  }
}
