export const LEGACY_BACKUP_ARCHIVE_VERSION = 1 as const;
export const CURRENT_BACKUP_ARCHIVE_VERSION = 2 as const;

export type BackupArchiveVersion =
  | typeof LEGACY_BACKUP_ARCHIVE_VERSION
  | typeof CURRENT_BACKUP_ARCHIVE_VERSION;

export interface BackupScryptParameters {
  N: number;
  r: number;
  p: number;
  maxmem: number;
}

const LEGACY_SCRYPT = Object.freeze({
  N: 16_384,
  r: 8,
  p: 1,
  maxmem: 64 * 1024 * 1024
} satisfies BackupScryptParameters);

const CURRENT_SCRYPT = Object.freeze({
  N: 131_072,
  r: 8,
  p: 1,
  maxmem: 256 * 1024 * 1024
} satisfies BackupScryptParameters);

export function backupScryptPolicy(version: unknown): Readonly<BackupScryptParameters> | undefined {
  if (version === LEGACY_BACKUP_ARCHIVE_VERSION) return LEGACY_SCRYPT;
  if (version === CURRENT_BACKUP_ARCHIVE_VERSION) return CURRENT_SCRYPT;
  return undefined;
}
