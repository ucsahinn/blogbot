export type CodexTaskKind =
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
  FAST: "gpt-5.6-luna",
  DEFAULT: "gpt-5.6-terra",
  DEEP_REVIEW: "gpt-5.6-sol"
};

const taskRoles = {
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
