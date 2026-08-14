export type BackupErrorCode =
  | "BACKUP_ARCHIVE_INVALID"
  | "BACKUP_DECRYPT_FAILED"
  | "BACKUP_FILE_INTEGRITY_INVALID"
  | "BACKUP_LIMIT_EXCEEDED"
  | "BACKUP_PATH_UNSAFE"
  | "BACKUP_RECOVERY_KEY_WEAK"
  | "BACKUP_SOURCE_INVALID"
  | "RESTORE_PLAN_INVALID"
  | "RESTORE_TARGET_EXISTS";

export class BackupError extends Error {
  readonly code: BackupErrorCode;

  constructor(code: BackupErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "BackupError";
    this.code = code;
  }
}
