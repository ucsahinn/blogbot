import type { OutboxEffect } from "../../../packages/database/src/backend-repository.ts";
import {
  reconcileApprovedPublication,
  type ApprovedPublicationCommand,
  type PublicationEffectsPort,
  type PublicationReconcileResult
} from "./publication.ts";

/** Connector readiness is deliberately supplied by the host. The publisher
 * runtime never reads tokens or reaches into process-global auth state. */
export type PublicationConnectorState = "READY" | "LOGIN_REQUIRED" | "DEGRADED";

export interface PublicationRuntimeConnector {
  state: PublicationConnectorState;
  reason?: string;
}

export interface PublicationRuntimeResolver {
  /** Resolve the immutable, approval-bound command represented by an outbox row. */
  resolve(effect: OutboxEffect): Promise<ApprovedPublicationCommand | null>;
}

export interface PublicationRuntimeOptions {
  resolver: PublicationRuntimeResolver;
  connector: PublicationRuntimeConnector;
  effects?: PublicationEffectsPort;
}

export interface PublicationRuntimeResult {
  state: "SUCCEEDED" | "FAILED" | "UNKNOWN";
  resultRef?: string;
  lastError?: string;
}

const unavailable = (reason: string): PublicationRuntimeResult => ({
  state: "UNKNOWN",
  lastError: reason.slice(0, 512)
});

/**
 * Local outbox boundary for publication. It can reconcile only when the host
 * explicitly provides both a READY connector assessment and remote effects.
 * Missing auth, command material, or effects is observable and retryable; no
 * remote call is attempted and no intent is marked as published.
 */
export function createConnectorAwarePublicationProcessor(options: PublicationRuntimeOptions) {
  if (!options || typeof options.resolver?.resolve !== "function") {
    throw new Error("publication runtime requires a command resolver");
  }
  return {
    async process(effect: OutboxEffect): Promise<PublicationRuntimeResult> {
      if (effect.type !== "PUBLISH_REVISION") return unavailable("unsupported publication outbox effect");
      if (options.connector.state !== "READY") {
        return unavailable(options.connector.reason ?? `publication connector is ${options.connector.state.toLowerCase()}`);
      }
      if (!options.effects) return unavailable("publication remote effects are unavailable");
      const command = await options.resolver.resolve(effect);
      if (!command) return unavailable("approved publication command is unavailable");
      if (command.revisionId !== effect.aggregateId) {
        return unavailable("outbox revision does not match the approved command");
      }
      if (
        typeof effect.revisionHash !== "string" ||
        effect.revisionHash.length !== 64 ||
        effect.revisionHash.toLowerCase() !== command.approvedRevisionHash.toLowerCase()
      ) {
        return unavailable("outbox revision hash does not match the immutable approved command");
      }
      const result = await reconcileApprovedPublication(command, options.effects);
      return resultToProcessorResult(result);
    }
  };
}

function resultToProcessorResult(result: PublicationReconcileResult): PublicationRuntimeResult {
  if (result.state === "WAITING_FOR_CHECKS") {
    return { state: "UNKNOWN", resultRef: result.pullRequestKey, lastError: "required checks are still pending" };
  }
  return { state: "SUCCEEDED", resultRef: result.deployIntent.key };
}
