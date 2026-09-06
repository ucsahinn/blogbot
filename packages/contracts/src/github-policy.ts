const workflowFilenamePattern = /^[A-Za-z0-9_.-]+\.ya?ml$/u;

/**
 * Conservative filename-only contract shared by every GitHub Actions
 * publication boundary. Workflows live directly under .github/workflows, so
 * path separators and traversal-shaped names are intentionally excluded.
 */
export function isSafeGitHubWorkflowName(value: unknown): value is string {
  return typeof value === "string"
    && value.length <= 100
    && !value.includes("..")
    && workflowFilenamePattern.test(value);
}
