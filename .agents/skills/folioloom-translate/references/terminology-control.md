# Live terminology control

Use these commands from `<folio-cli>`. They emit UTF-8 JSON and are the only supported
control path for live terminology and audited bulk correction.

## Inspect and queue an edit

List current knowledge and its generation/snapshot:

```text
npm run folioloom -- book knowledge list --store <book.db> --run <run-id>
```

Create a small untracked UTF-8 JSON request file containing `requestId`,
`expectedGeneration`, `expectedSnapshotId`, and `commands`. Do not include `runId`; the CLI
binds the trusted `--run`. A scoped term command has this shape:

```json
{
  "requestId": "unique-request-id",
  "expectedGeneration": 4,
  "expectedSnapshotId": "snapshot-id-from-list",
  "commands": [{
    "type": "upsert",
    "objectType": "term",
    "normalizedSubject": "source-name",
    "kind": "term_rendering_rule:stable-rule-id",
    "expectedRevision": null,
    "expectedScopeRevision": null,
    "fieldPatch": {
      "ruleId": "stable-rule-id",
      "conceptId": "stable-entity-or-concept-id",
      "sourceForms": ["Source Name"],
      "target": "目标译名",
      "allowedTargets": ["目标译名"],
      "policy": "locked",
      "locked": true,
      "selector": { "kind": "whole_book" },
      "priority": 10
    },
    "ownedFields": ["/target", "/allowedTargets", "/selector", "/priority"],
    "scope": "book",
    "evidence": [],
    "origin": "manual"
  }]
}
```

For a bounded name period, replace `selector` with the inclusive immutable range reported by
the book store:

```json
{
  "kind": "block_range",
  "sourceVersion": "source-version",
  "startBlockId": "first-block-id",
  "endBlockId": "last-block-id",
  "startGlobalIndex": 120,
  "endGlobalIndex": 248
}
```

Submit it:

```text
npm run folioloom -- book knowledge term-upsert --store <book.db> --run <run-id> --input <request.json>
```

`applied` is effective now. `queued` is durable and will become effective at a safe boundary.
Inspect or cancel a still-queued request with:

```text
npm run folioloom -- book knowledge queue-status --store <book.db> --run <run-id>
npm run folioloom -- book knowledge queue-cancel --store <book.db> --run <run-id> --request <request-id>
```

Do not resubmit with a different payload under the same request ID. After a queued edit is no
longer listed, run `book knowledge list` again and locate the active revision ID for the exact
subject and `kind`.

## Preview and execute correction

Planning is read-only with respect to translations and returns a canonical plan hash:

```text
npm run folioloom -- book retrofit plan --store <book.db> --run <run-id> --revision <rule-revision-id> --request <unique-request-id>
```

Explain the summary before applying. `localRepair` creates a new translation version only
when exact term receipts make replacement unambiguous. `modelRetranslate` enters the existing
durable revalidation executor. `humanRequired` remains an explicit blocker.

Apply only the exact reviewed plan:

```text
npm run folioloom -- book retrofit apply --store <book.db> --run <run-id> --job <job-id> --plan-hash <plan-hash>
```

Inspect one job or all jobs:

```text
npm run folioloom -- book retrofit status --store <book.db> --run <run-id> --job <job-id>
npm run folioloom -- book retrofit status --store <book.db> --run <run-id>
```

If model items are `running`, resume `book run` with the original run identity and worker
arguments. The final barrier drains those tasks and refreshes the retrofit job. Strict export
stays blocked until every item converges.

## Roll back

Rollback restores the job's prior active translation versions and creates a rollback/supersede
knowledge revision; it never deletes history:

```text
npm run folioloom -- book retrofit rollback --store <book.db> --run <run-id> --job <job-id>
```

Rollback fails closed if a later operation has already replaced one of the job's translations.
Run audit and strict export again after rollback.
