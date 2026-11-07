import test from "node:test";
import assert from "node:assert/strict";
import { currentWindowsTrustee, isPrivateWindowsAcl } from "./windows-acl.mjs";

const localUser = "S-1-5-21-111-222-333-1001";
const domainAdministrator = "S-1-5-21-444-555-666-500";
const privateAcl = trustee => "D:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;FA;;;" + trustee + ")";

for (const trustee of [localUser, domainAdministrator, "LA", "SY", "LS", "NS"]) {
  test("native single-principal probe binds current identity: " + trustee, () => {
    const current = currentWindowsTrustee("D:P(A;OICI;FA;;;" + trustee + ")");
    assert.equal(current, trustee);
    assert.equal(isPrivateWindowsAcl(privateAcl(trustee), current), true);
  });
}

test("LA is not trusted for ordinary users or domain SIDs ending in 500", () => {
  for (const trustee of [localUser, domainAdministrator]) {
    const current = currentWindowsTrustee("D:P(A;OICI;FA;;;" + trustee + ")");
    assert.equal(isPrivateWindowsAcl(privateAcl("LA"), current), false);
    assert.equal(isPrivateWindowsAcl(privateAcl(trustee) + "(A;;FA;;;LA)", current), false);
  }
});

test("reject ambiguous, inherited, partial, malformed or absent identity probes", () => {
  for (const descriptor of [undefined, "", "D:", "D:NO_ACCESS_CONTROL", "D:P(A;OICI;FA;;;LA)(A;;FA;;;WD)",
    "D:P(A;OICIID;FA;;;LA)", "D:P(A;OICIIO;FA;;;LA)", "D:P(A;OICI;FR;;;LA)",
    "D:P(D;OICI;FA;;;LA)", "D:P(A;OICI;FA;object;;LA)", "D:P(A;OICI;FA;;;LA)junk"]) {
    assert.equal(currentWindowsTrustee(descriptor), undefined, String(descriptor));
  }
});

test("reject foreign allow ACEs even alongside current user full control", () => {
  for (const foreign of ["WD", "BU", "AU", "LG", domainAdministrator]) {
    assert.equal(isPrivateWindowsAcl(privateAcl(localUser) + "(A;;FR;;;" + foreign + ")", localUser), false);
  }
});

test("require effective current-user full control and fail closed on malformed ACL", () => {
  for (const descriptor of [undefined, "D:", "D:NO_ACCESS_CONTROL", "D:P(A;;FA;;;BA)",
    "D:P(A;IO;FA;;;LA)", "D:P(A;;FR;;;LA)", "D:P(A;;FA;object;;LA)",
    "D:P(A;;FA;;;LA;extra)", "D:P(OA;;FA;;;LA)", "D:P(A;;FA;;;LA)junk"]) {
    assert.equal(isPrivateWindowsAcl(descriptor, "LA"), false, String(descriptor));
  }
  assert.equal(isPrivateWindowsAcl(privateAcl("LA"), undefined), false);
});

test("retain inherited private file ACEs, trusted system trustees and deny ACE semantics", () => {
  assert.equal(isPrivateWindowsAcl("D:AI(A;ID;FA;;;LA)(A;;FA;;;S-1-5-18)(A;;FA;;;S-1-5-32-544)", "LA"), true);
  assert.equal(isPrivateWindowsAcl(privateAcl(localUser) + "(D;;FW;;;WD)", localUser), true);
});
