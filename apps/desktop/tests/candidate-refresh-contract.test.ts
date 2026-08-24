import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("candidate mutations refresh the candidate-inclusive workspace projection", async () => {
  const [flow, app] = await Promise.all([
    readFile(new URL("../src/screens/ContentFlow.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/App.tsx", import.meta.url), "utf8")
  ]);
  const singleMutation = flow.slice(flow.indexOf("const mutate ="), flow.indexOf("const mutateSelected ="));
  const bulkStart = flow.indexOf("const mutateSelected =");
  const bulkMutation = flow.slice(bulkStart, flow.indexOf("\n  return (", bulkStart));

  assert.doesNotMatch(singleMutation, /bridge\.getEditorialWorkspace\(\)/u);
  assert.doesNotMatch(bulkMutation, /bridge\.getEditorialWorkspace\(\)/u);
  assert.ok(
    (singleMutation.match(/bridge\.getEditorialWorkspace\(\{ includeCandidates: true \}\)/gu) ?? []).length >= 3,
    "single promote/dismiss refreshes must preserve the candidate projection"
  );
  assert.match(
    bulkMutation,
    /bridge\.getEditorialWorkspace\(\{ includeCandidates: true \}\)/u,
    "bulk candidate actions must preserve the remaining candidate projection"
  );
  const catalogRefresh = app.slice(
    app.indexOf("const refreshWorkspaceForMutation"),
    app.indexOf("const openDiagnostics", app.indexOf("const refreshWorkspaceForMutation"))
  );
  assert.match(catalogRefresh, /getEditorialWorkspace\(\{ includeCandidates: true \}\)/u,
    "the source-catalog refresh callback must not overwrite candidate rows with the default projection");
});
