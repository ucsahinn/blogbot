export interface DesktopPreflightCheck {
  id: string;
  status: "PASS" | "FAIL";
  detail: string;
}

export interface DesktopPreflightResult {
  ok: boolean;
  checks: DesktopPreflightCheck[];
}

export function runDesktopPreflight(input?: {
  artifactsDir?: string;
}): Promise<DesktopPreflightResult>;
