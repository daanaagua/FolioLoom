import assert from "node:assert/strict";
import test from "node:test";

import { runtimeProfilePath } from "../src/desktop/runtime-profile-path.js";

test("desktop creates one runtime profile store under userData", () => {
  assert.equal(
    runtimeProfilePath("C:\\UserData"),
    "C:\\UserData\\runtime-profiles.db",
  );
  assert.equal(
    runtimeProfilePath("/var/lib/folioloom"),
    "/var/lib/folioloom/runtime-profiles.db",
  );
});
