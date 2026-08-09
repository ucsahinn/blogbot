export const WINDOWS_CONSOLE_SUBSYSTEM: number;
export const WINDOWS_GUI_SUBSYSTEM: number;

export function readWindowsPeSubsystem(image: Buffer): number;
export function setWindowsGuiSubsystem(image: Buffer): boolean;
