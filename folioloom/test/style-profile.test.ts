import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { loadStyleProfile } from "../src/style/style-profile.js";

function writeStyleProfile(contents: string): string {
  const directory = mkdtempSync(join(tmpdir(), "folioloom-style-profile-"));
  const path = join(directory, "style.yaml");
  writeFileSync(path, contents, "utf8");
  return path;
}

test("loads a partial YAML profile and appends the CLI style prompt", () => {
  const profile = loadStyleProfile({
    profilePath: writeStyleProfile([
      "style:",
      '  register: "准确、克制"',
      '  dialogue: "对白自然"',
      '  additionalInstruction: "专名以术语表为准。"',
    ].join("\n")),
    cliPrompt: "不要把普通对白译成文言。",
  });

  assert.deepEqual(profile.styleState, {
    register: "准确、克制",
    dialogue: "对白自然",
    additionalInstruction: "专名以术语表为准。\n不要把普通对白译成文言。",
  });
  assert.equal(profile.source.profile, true);
  assert.equal(profile.source.cliPrompt, true);
  assert.match(profile.profileHash ?? "", /^[a-f0-9]{64}$/u);
});

test("uses no hash when neither a profile nor a CLI style prompt is supplied", () => {
  const profile = loadStyleProfile({});

  assert.deepEqual(profile.styleState, {});
  assert.equal(profile.profileHash, undefined);
  assert.deepEqual(profile.source, { profile: false, cliPrompt: false });
});

test("hashes equivalent YAML style fields deterministically", () => {
  const first = loadStyleProfile({
    profilePath: writeStyleProfile([
      "style:",
      '  register: "准确、克制"',
      '  dialogue: "对白自然"',
    ].join("\n")),
  });
  const second = loadStyleProfile({
    profilePath: writeStyleProfile([
      "style:",
      '  dialogue: "对白自然"',
      '  register: "准确、克制"',
    ].join("\n")),
  });

  assert.equal(first.profileHash, second.profileHash);
});

test("rejects malformed, unknown, and overlong style input before a run", () => {
  assert.throws(
    () => loadStyleProfile({
      profilePath: writeStyleProfile("style:\n  unlisted: value\n"),
    }),
    /unknown style field: unlisted/u,
  );
  assert.throws(
    () => loadStyleProfile({ cliPrompt: "x".repeat(601) }),
    /--prompt exceeds 600 Unicode scalars/u,
  );
  assert.throws(
    () => loadStyleProfile({
      profilePath: writeStyleProfile("style:\n  dialogue: 12\n"),
    }),
    /style\.dialogue must be a non-empty string/u,
  );
});
