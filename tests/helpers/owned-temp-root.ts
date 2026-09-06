import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";

type AsyncCleanup = () => Promise<void>;

export interface OwnedTempRoot {
  path: string;
  track(cleanup: AsyncCleanup): AsyncCleanup;
}

export async function createOwnedTempRoot(
  t: TestContext,
  prefix: string
): Promise<OwnedTempRoot> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  const cleanups: AsyncCleanup[] = [];

  t.after(async () => {
    let firstError: unknown;
    for (const cleanup of cleanups.reverse()) {
      try {
        await cleanup();
      } catch (error) {
        firstError ??= error;
      }
    }
    try {
      await rm(path, {
        recursive: true,
        force: true,
        maxRetries: 20,
        retryDelay: 50
      });
    } catch (error) {
      firstError ??= error;
    }
    if (firstError !== undefined) throw firstError;
  });

  return {
    path,
    track(cleanup) {
      let result: Promise<void> | undefined;
      const once = () => result ??= cleanup();
      cleanups.push(once);
      return once;
    }
  };
}
