export interface LocalPersistencePort<Value> {
  readonly persistence: "memory" | "local";
  read(): Promise<Value | null>;
  write(value: Value): Promise<void>;
}

export class InMemoryLocalPersistence<Value>
  implements LocalPersistencePort<Value>
{
  readonly persistence = "memory" as const;
  private value: Value | null = null;

  async read(): Promise<Value | null> {
    return this.value === null ? null : structuredClone(this.value);
  }

  async write(value: Value): Promise<void> {
    this.value = structuredClone(value);
  }
}

/** Crash-safe JSON persistence for the local engine's small recovery records. */
export class JsonFileLocalPersistence<Value> implements LocalPersistencePort<Value> {
  readonly persistence = "local" as const;

  constructor(private readonly filePath: string) {}

  async read(): Promise<Value | null> {
    const { readFile } = await import("node:fs/promises");
    try {
      const raw = await readFile(this.filePath, "utf8");
      return JSON.parse(raw) as Value;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async write(value: Value): Promise<void> {
    const { mkdir, rename, writeFile } = await import("node:fs/promises");
    const { dirname, join } = await import("node:path");
    await mkdir(dirname(this.filePath), { recursive: true });
    const temporary = join(dirname(this.filePath), `.${Date.now()}.${process.pid}.tmp`);
    await writeFile(temporary, `${JSON.stringify(value)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, this.filePath);
  }
}
