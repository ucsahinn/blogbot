export type CodexTaskKind =
  | "BOBY_GUIDE"
  | "CLASSIFY"
  | "METADATA"
  | "DEDUPE"
  | "EXTRACT"
  | "RESEARCH"
  | "WRITE_TR"
  | "LOCALIZE_EN"
  | "CHECK_CONTRADICTIONS"
  | "CHECK_HIGH_RISK"
  | "FINAL_QUALITY";

export type CodexLogicalRole = "FAST" | "DEFAULT" | "DEEP_REVIEW";

export interface CodexRoleSelection {
  role: CodexLogicalRole;
  model: string;
}

export type CodexRoleModels = Readonly<Record<CodexLogicalRole, string>>;

export const defaultCodexRoleModels: CodexRoleModels = {
  // Codex CLI account entitlements decide the available model. Do not invent
  // role-specific model identifiers: an unavailable name makes a healthy
  // local runner fail before it can emit structured output.
  FAST: "default",
  DEFAULT: "default",
  DEEP_REVIEW: "default"
};

const taskRoles = {
  BOBY_GUIDE: "FAST",
  CLASSIFY: "FAST",
  METADATA: "FAST",
  DEDUPE: "FAST",
  EXTRACT: "FAST",
  RESEARCH: "DEFAULT",
  WRITE_TR: "DEFAULT",
  LOCALIZE_EN: "DEFAULT",
  CHECK_CONTRADICTIONS: "DEEP_REVIEW",
  CHECK_HIGH_RISK: "DEEP_REVIEW",
  FINAL_QUALITY: "DEEP_REVIEW"
} as const satisfies Record<CodexTaskKind, CodexLogicalRole>;

export function resolveCodexRole(
  taskKind: CodexTaskKind,
  roleModels: CodexRoleModels = defaultCodexRoleModels
): CodexRoleSelection {
  const role = taskRoles[taskKind];
  return { role, model: roleModels[role] };
}
