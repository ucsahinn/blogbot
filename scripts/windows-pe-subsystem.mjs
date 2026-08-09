const DOS_MAGIC = 0x5a4d;
const PE_SIGNATURE = "PE\0\0";
const PE_OFFSET_LOCATION = 0x3c;
const FILE_HEADER_SIZE = 20;
const OPTIONAL_HEADER_SUBSYSTEM_OFFSET = 68;

export const WINDOWS_CONSOLE_SUBSYSTEM = 3;
export const WINDOWS_GUI_SUBSYSTEM = 2;

function requiredSubsystemOffset(image) {
  if (!Buffer.isBuffer(image) || image.length < PE_OFFSET_LOCATION + 4) {
    throw new Error("PE_IMAGE_TOO_SMALL");
  }
  if (image.readUInt16LE(0) !== DOS_MAGIC) {
    throw new Error("PE_DOS_SIGNATURE_INVALID");
  }
  const peOffset = image.readUInt32LE(PE_OFFSET_LOCATION);
  const optionalHeaderOffset = peOffset + 4 + FILE_HEADER_SIZE;
  if (peOffset + 4 > image.length || image.toString("ascii", peOffset, peOffset + 4) !== PE_SIGNATURE) {
    throw new Error("PE_SIGNATURE_INVALID");
  }
  if (optionalHeaderOffset + OPTIONAL_HEADER_SUBSYSTEM_OFFSET + 2 > image.length) {
    throw new Error("PE_OPTIONAL_HEADER_TRUNCATED");
  }
  const optionalHeaderSize = image.readUInt16LE(peOffset + 4 + 16);
  if (optionalHeaderSize < OPTIONAL_HEADER_SUBSYSTEM_OFFSET + 2) {
    throw new Error("PE_OPTIONAL_HEADER_INVALID");
  }
  const magic = image.readUInt16LE(optionalHeaderOffset);
  if (magic !== 0x10b && magic !== 0x20b) {
    throw new Error("PE_OPTIONAL_HEADER_MAGIC_INVALID");
  }
  return optionalHeaderOffset + OPTIONAL_HEADER_SUBSYSTEM_OFFSET;
}

export function readWindowsPeSubsystem(image) {
  return image.readUInt16LE(requiredSubsystemOffset(image));
}

/**
 * Node SEA copies node.exe, which is a console-subsystem executable. A local
 * stdio sidecar has no user-facing console contract, so changing only its PE
 * subsystem prevents Windows from creating a conhost/Command Prompt surface.
 */
export function setWindowsGuiSubsystem(image) {
  const offset = requiredSubsystemOffset(image);
  if (image.readUInt16LE(offset) === WINDOWS_GUI_SUBSYSTEM) return false;
  image.writeUInt16LE(WINDOWS_GUI_SUBSYSTEM, offset);
  return true;
}
