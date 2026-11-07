// Descriptors are native icacls /save output, not caller-supplied identity claims.
export function currentWindowsTrustee(descriptor) {
  // The fresh probe is granted to the exact whoami SID with inheritance removed.
  // Trust its serialized identity only when there is exactly one explicit ACE.
  return /^D:[A-Z]*\(A;OICI;FA;;;([A-Z]{2}|S-1-[0-9-]+)\)$/.exec(descriptor)?.[1];
}

export function isPrivateWindowsAcl(descriptor, currentTrustee) {
  if (!currentTrustee || !/^D:[A-Z]*(?:\([^()]*\))+$/.test(descriptor)) return false;
  const allowed = new Set([currentTrustee, "BA", "SY", "S-1-5-18", "S-1-5-32-544"]);
  let currentUserAllowed = false;
  for (const match of descriptor.matchAll(/\(([^()]*)\)/g)) {
    const parts = match[1].split(";");
    if (parts.length !== 6) return false;
    const [type, flags, rights, object, inherited, identity] = parts;
    if (type === "D") continue;
    if (type !== "A" || object || inherited || !allowed.has(identity)) return false;
    if (identity === currentTrustee && rights === "FA" && !flags.includes("IO")) currentUserAllowed = true;
  }
  return currentUserAllowed;
}
