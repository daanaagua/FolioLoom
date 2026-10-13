import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fauxProvider, fauxAssistantMessage, type Context } from "@earendil-works/pi-ai";
import { importSource } from "../src/source/source-importer.js";
import { runBook } from "../src/fullbook/book-runner.js";
import { LosslessBookStore } from "../src/storage/lossless-book-store.js";
import { auditLosslessBookExport, writeLosslessBookArtifacts } from "../src/report.js";
import { verifyExport } from "../src/export/export-verifier.js";

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "folioloom-revision-")), source = join(root, "source.txt");
  writeFileSync(source, Array.from({ length: 4 }, (_, i) => `Chapter ${i + 1}\n\n` + "Heron Isle is named for the birds nesting there. ".repeat(40)).join("\n\n"));
  const imported = await importSource({ sourcePath: source, projectDirectory: join(root, "project"), sourceLanguage: "en" });
  const faux = fauxProvider(); let calls = 0;
  const snapshots: any[] = [];
  faux.setResponses(Array.from({ length: 10 }, () => async (context: Context) => {
    const message = context.messages.findLast(m => m.role === "user")!;
    const p = JSON.parse(typeof message.content === "string" ? message.content : message.content.filter(c => c.type === "text").map(c => c.text).join(""));
    const n = ++calls; snapshots.push(p.sharedNames);
    if (n === 2) await new Promise(r => setTimeout(r, 20));
    const shared = p.sharedNames.find((s: any) => s.source === "Heron Isle");
    const first = p.paragraphs.find(([, s]: [string, string]) => s.includes("Heron Isle"));
    const target = n === 2 || n > 3 ? "鹭岛" : "赫伦岛";
    return fauxAssistantMessage(JSON.stringify({ paragraphs: p.paragraphs.map(([id, source]: [string, string]) => [id, source.includes("Heron Isle") ? `${target}在海中。` : "章节"]),
      names: !shared ? [{ id: "new1", source: "Heron Isle", target, kind: "place", scope: "book", evidence: { paragraphId: first[0], quote: "Heron Isle" } }] : [],
      nameUses: p.paragraphs.filter(([, s]: [string, string]) => s.includes("Heron Isle")).map(([id]: [string]) =>
        ({ nameId: shared?.nameId ?? "new1", paragraphId: id, quote: "Heron Isle", target, occurrence: 0 })),
      nameChanges: n === 2 ? [{ nameId: shared.nameId, expectedRevision: shared.revision, target, reason: "The source explains the bird name.", evidence: { paragraphId: first[0], quote: "Heron Isle is named for the birds nesting there." } }] : [] }));
  }));
  const options = { workflow: "direct" as const, manifestPath: imported.manifestPath, storePath: join(root, "book.db"),
    runMeta: { runId: "revisions", protocolVersion: "test" }, model: faux.getModel(), streamFn: faux.provider.streamSimple.bind(faux.provider),
    windowOptions: { maxBlocks: 1, maxSourceTokens: 800 }, maxConcurrency: 2, schedulerMode: "active" as const };
  return { options, calls: () => calls, snapshots };
}

test("protocol five commits a shared revision, patches peers and historical versions, and dispatches no reviews", async () => {
  const f = await fixture(); const result = await runBook(f.options);
  assert.equal(result.outcome, "completed"); assert.equal(f.calls(), result.status.totalWindows);
  assert.equal(f.snapshots[1][0].revision, 1); assert.equal(f.snapshots[2][0].revision, 1);
  assert.equal(f.snapshots[3][0].revision, 2);
  const db = LosslessBookStore.openReadOnly(f.options.storePath);
  try {
    assert.equal(db.directNames("revisions")[0]!.target, "鹭岛");
    assert.equal(db.directNames("revisions")[0]!.revision, 2);
    assert.ok(db.activeTranslations("revisions").some(t => t.version === 2));
    assert.ok(db.activeTranslations("revisions").every(t => !t.text.includes("赫伦岛")));
    assert.equal(db.supervisionRecords("revisions").length, 0); assert.equal(db.qualityRecords("revisions").length, 0);
    assert.equal(auditLosslessBookExport(db, "revisions").audit.strictExportable, true);
    const artifacts = writeLosslessBookArtifacts(db, "revisions", join(dirname(f.options.storePath), "export"), { deliveryMode: "strict" });
    assert.equal(verifyExport(artifacts, db, "revisions", "strict").ok, true);
    const response = db.directRecords("revisions").find(r => r.kind === "response")!;
    assert.ok(String(response.payload.text).includes("赫伦岛"), "raw response is immutable");
  } finally { db.close(); }
});

test("a crash after translations commit but before name publication resumes without new calls", async t => {
  const f = await fixture(); const publish = LosslessBookStore.prototype.commitDirectNameRevisionPlan;
  let publications = 0;
  const fault = t.mock.method(LosslessBookStore.prototype, "commitDirectNameRevisionPlan", function(this: LosslessBookStore, ...args: Parameters<typeof publish>) {
    if (++publications === 2) throw new Error("publication crash");
    return publish.apply(this, args);
  });
  await assert.rejects(() => runBook({ ...f.options, maxWindows: 3 }), /publication crash/u);
  assert.equal(f.calls(), 3); fault.mock.restore();
  let db = LosslessBookStore.openReadOnly(f.options.storePath);
  assert.equal(db.directNames("revisions")[0]!.revision, 1);
  assert.ok(auditLosslessBookExport(db, "revisions").audit.incidentCodes.includes("DIRECT_NAMING_WAVE_PENDING")); db.close();
  let armed = false;
  const transactional = new LosslessBookStore(f.options.storePath, { checkpoint: name => { if (armed && name === "before_commit") throw new Error("atomic publication fault"); } });
  try {
    const plan = transactional.directRecords("revisions").findLast(r => r.kind === "name_revision_plan")!;
    const patches = plan.payload.historicalPatches as Parameters<typeof publish>[2];
    const before = transactional.activeTranslations("revisions");
    armed = true;
    assert.throws(() => transactional.commitDirectNameRevisionPlan("revisions", plan.key, patches), /atomic publication fault/u);
    armed = false;
    assert.deepEqual(transactional.activeTranslations("revisions"), before);
    assert.equal(transactional.directNames("revisions")[0]!.revision, 1);
    assert.throws(() => transactional.commitDirectNameRevisionPlan("revisions", plan.key, patches.map(p => ({ ...p, expectedVersion: p.expectedVersion + 1 }))), /frozen plan/u);
  } finally { transactional.close(); }
  await runBook({ ...f.options, maxWindows: 0 });
  assert.equal(f.calls(), 3);
  db = LosslessBookStore.openReadOnly(f.options.storePath);
  try { assert.equal(db.directNames("revisions")[0]!.revision, 2); assert.ok(db.activeTranslations("revisions").some(t => t.version === 2)); }
  finally { db.close(); }
});
