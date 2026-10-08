# Release Channels and Support Policy

This policy is the canonical source for choosing an Engram release and planning an upgrade or rollback.

## Choose a release channel

| Channel | Intended use | Security support | Production guidance |
| --- | --- | --- | --- |
| Latest stable | General and production use | Receives security fixes | Recommended for production |
| Release candidate (RC) | Prerelease validation and feedback | Not guaranteed | Not universally suitable for production |
| Older release | Legacy or temporary compatibility needs | Does not receive security fixes | Upgrade to the latest stable release when practical |

Release candidates may expose functionality not yet available in the latest stable release. Operators who need that functionality accept prerelease risk, including the absence of guaranteed security support and universal production suitability.

## Upgrade deliberately

Before upgrading:

1. Choose the release channel deliberately.
2. Read the release notes and any migration notes for the target release.
3. Back up relevant state and configuration.
4. Validate compatibility with your environment and integrations.
5. Retain a known-good installation or artifact until the upgrade is accepted.

## Rollback expectations

Rollback means restoring the known-good release and configuration, plus any required backup, using the documented procedure for the affected component. It does not promise an automated rollback path or behavior beyond that component's documentation. Feature or data migrations can constrain rollback; consult the release-specific notes before upgrading.

## Pi managed-pin consent and recovery

Existing Engram references—including historical/current pins, custom sources,
filtered objects and duplicates—are not evidence of ownership. Setup and
`pi-engram init` block unmarked references without installing or editing settings.
`--force` does not grant consent. Custom specifications are never replaced.

Back up `settings.json`, `mcp.json` and the known-good installation first. For
one existing canonical SemVer pin, explicitly run
`pi-engram adopt npm:gentle-engram@<exact-existing-version>`.
Adoption only records consent; it does not install or migrate the package.
Then run Engram's Pi setup or `pi-engram init` to migrate to the bundled pin.
Fresh configurations record consent automatically. The settings marker is exactly
`"engramManagedPin": {"schema": 1, "package": "npm:gentle-engram@<version>"}`:
two keys, schema number 1, and an exact match to the sole string reference.
It is local authorization metadata, not cryptographic ownership proof. Invalid,
stale or conflicting markers block, including adoption; inspect them manually.

Setup validates before `pi install`. After success it accepts only unchanged
settings or Pi's expected single package change, retaining the old marker and
all unrelated values, before writing the new marker and any npmCommand addition.
Unexpected changes produce a conflict without overwrite or automatic restore.
Installer failure causes no Engram settings write: failure during package
installation skips Pi's package persistence, but persistence errors and package
artifacts are not atomic rollback. Inspect settings/marker and command diagnostics
before retrying. Read back the package and marker as the local audit record.
To roll back, restore the backed-up settings/MCP configuration and known-good
installation deliberately; no automatic downgrade or global ledger is provided.

## Check release lag

The [stable release gap audit](../.github/workflows/release-gap-audit.yml) runs weekly and can be dispatched manually. It compares npm's `gentle-engram/latest` to the matching `pi-v*` tag and the latest stable GitHub Release to its `v*` tag. Changes on `main` to Pi plugin or Go runtime/build inputs after those tags produce a failing run and an actionable step summary. Documentation-only changes do not trigger a gap. Path changes are only a signal to review release need; they do not identify fixes or guarantee an artifact is broken. Unavailable metadata or missing tags fail the run rather than implying the channel is current. Maintainers should inspect the summary and changes, decide whether publication is appropriate, and use the existing tag-driven release workflows; the audit never publishes or edits issues.

The Pi npm publish workflow also supports manual dispatch, but it only publishes when the selected GitHub ref is the full `refs/tags/pi-v<package version>` tag matching `plugin/pi/package.json`. Select that tag for a manual run: dispatching from a branch, even one named `pi-v<package version>`, fails the release preflight.

## Release version contract boundary

The existing Pi preflight (`plugin/pi/test/release-contract.mjs`) requires strict
SemVer 2.0 and exact agreement between the full `refs/tags/pi-v<version>` ref,
`plugin/pi/package.json`, and the current installer pin. Metadata parsing, the
single-pin check, and CLI install guidance remain required before publication.
Branches, shorthand tags, malformed versions, and the core tag prefix fail closed.

The pure validator in `plugin/pi/release/version-contract.mjs` also provides an
explicit core route for a future coordinated train: `refs/tags/v<version>` must
agree exactly with supplied package, installer, and optional Pi metadata versions.
Omitted Pi metadata is allowed; supplied null, missing-value, or nonstring metadata
is rejected. Prerelease and build identifiers follow SemVer 2.0, including numeric
leading-zero restrictions; build identifiers may contain leading zeros. Agreement
includes build metadata even though SemVer precedence ignores it.

This is tested validation capability, not an active lockstep release workflow.
Core and Pi publication remain independent, with the supported Pi tag route and
preflight/test/publish order unchanged. No version or pin is selected or bumped;
publication orchestration, destination lookup, resumability, ProfileAgent parity,
and managed-pin migration are outside this boundary.

### Real-dependency schema capture (explicit offline fixture)

`schema-capture.mjs` projects Pi input schemas into JSON plus `schemaMetadata`.
Only recognized TypeBox `~kind` and `~optional` fields are moved into that
record, retaining path segments, value and enumerable/configurable/writable
flags. Records sort by path depth, JSON-encoded path and key. Other hidden
fields, symbols, accessors, cycles and unsupported values reject as
`unsupported Pi schema`; JSON constraints and array order are preserved.

From `plugin/pi`, with offline Go dependencies and an installed Pi SDK:

```sh
node --test test/release-schema-capture.test.mjs
ENGRAM_RELEASE_SOURCE_COMMIT=<full-source-commit> ENGRAM_PI_SDK_ROOT=/absolute/path/to/installed/pi-coding-agent node --test test/release-schema-capture.mjs
```

The explicit fixture loads actual plugin registrations with installed TypeBox
and TUI dependencies, not stubs. It captures 22 Pi schemas and the 19 actual MCP
`tools/list` records through the opt-in Go bridge. State, caches, logs and raw
`schema-capture.json` remain under Git's common directory at
`gentle-checks/t3-capture`; Go runs offline. This is registration-time schema
evidence, not Pi SDK session dispatch or host validation. Callback code is not
serialized. The producer requires the selected full source commit to match HEAD
and clean tracked/untracked runtime Go/Pi sources, including `go.mod`/`go.sum`,
before and after capture. Release helper/test edits are outside that runtime
source check. The capture v2 record carries the commit and its Git tree.

`buildContractManifest(capture, expectedSource)` requires those identities to
match the caller's expected commit/tree, rejects legacy or unbound captures,
and adds the documented T2 MCP/Pi dispositions without asserting equivalence.
It writes `contract-manifest.json` (canonical bytes) and `contract-identity.json`
(source identity and SHA-256 of those exact bytes), beside `schema-capture.json`.
The recorded behavioral dispositions include the accepted search variant:
with `project` plus `all_projects`, HTTP rejects with 400, Pi omits `project`
and succeeds globally, and MCP resolves globally (default and compact modes).
For missing observation IDs, MCP update errors retain
`Failed to update memory: sql: no rows in result set`; HTTP/Pi errors are
compared separately, not asserted text-identical. Project-list comparisons use
complete records and counts independently of order; this does not establish
a stable ordering contract or raw transport-order parity.

Git identity is separate from contract bytes: the same contract can occur in
multiple commits. Identity comparisons are not signatures, external approval,
proof against transient source changes, or publisher readiness.

Pure integration checks are explicit:

```sh
node --test test/release-contract-manifest.test.mjs test/release-schema-capture.test.mjs test/release-version-contract.test.mjs
```

Current pure tests use synthetic bound records, not runtime provenance evidence.
Real producer binding and rejection controls require their own isolated run.
Destination freshness, publication authorization and remaining release gates
are not supplied by the manifest or its recorded dispositions.

### Offline artifact and destination evidence

`release/artifact-evidence.mjs` supplies two pure helpers; neither publishes.
`buildArtifactIdentity({ source: { commit, tree }, contractBytes, contractDigest,
npmBytes, coreAssets })` requires full selected Git identities, exact canonical
contract bytes with their matching SHA-256, and Buffer/Uint8Array artifact bytes.
Core assets are `{ name, bytes, digest? }`; an optional digest must match bytes.
Empty/blank or duplicate names, invalid bytes/digests and an empty core set reject
with `TypeError: invalid artifact evidence`. No archive format is imposed.

The returned identity includes `sourceCommit`, `sourceTree`, `contractDigest`,
`npmDigest`, `coreDigest`, sorted `coreAssets` (each name and SHA-256), and
`coreManifestBytes`. Core digest hashes UTF-8 JSON with one LF:
`{"schema":"engram.core-assets/v1","assets":[{"name":"...","digest":"..."}]}`.
Names sort by JavaScript string comparison, independent of input order. npm digest
hashes exact tarball bytes; contract digest remains separate. Inputs are unchanged.
These integrity comparisons do not prove source-to-build correspondence,
provenance, signatures, approval or publication permission.

`bindDestinationObservation({ attemptId, destination, candidate, observation })`
requires a nonblank current attempt ID, destination `npm` or `core`, the candidate
identity plus `version`, and an observation with matching `attemptId`/`version`.
State must explicitly be `absent` or `present`; present observations require
`sourceCommit`, `contractDigest` and `contentDigest` (npm or core as appropriate).
Malformed, unknown, missing or previous-attempt evidence rejects with
`TypeError: invalid destination observation`. Valid immutable identity differences
are preserved for the planner to block; the operator chooses any corrective
version, never this helper. Returned fields are compatible with the existing
planner's absent/present snapshots; the offline composition below integrates them.

Adapters must query destinations anew for each publication/recovery attempt.
A matching attempt ID does **not** prove a new query happened. Offline fixtures
prove validation only, not live freshness; no timestamp or TTL is inferred.
Concurrency, staging/core/promotion execution and remaining release gates are
outside this unit. From `plugin/pi`, run the pure checks with:

```sh
node --test test/release-artifact-evidence.test.mjs
```

### Offline publication/recovery composition

`planPublicationAttempt({ version, attemptId, artifacts, destinations, gates })`
in `release/publication-attempt.mjs` builds the artifact identity, binds both
injected observations to the same attempt/version, then calls `planPublication`.
`artifacts` is the `buildArtifactIdentity` input above; `destinations` contains
`npm` and `core` observations. It returns `{ candidate, plan }`, retaining the
exact artifact identity including source tree and core manifest bytes.
Invalid artifacts return a null candidate and `invalid-artifact-evidence`;
invalid/missing/unknown/stale observations block with
`invalid-destination-observation:npm` or `:core`. All blocked plans have no actions.

The planner enforces strict SemVer and six explicit true gates: `goTests`,
`piTests`, `packageChecks`, `profileParity`, `semanticContract`, `trustedPublisher`.
Ready actions stage npm under `staging-<version>`, publish core if absent, then
promote npm to `next` for prereleases or `latest` for stable versions. Matching
immutable destinations are reused without republishing. Any source commit,
contract digest or destination content digest mismatch blocks with
`immutable-mismatch:<destination>` and `correctiveVersionRequired: true`.
Only the operator chooses a corrective version; nothing overwrites or increments it.

This action list is a pure plan, never executed. Inputs remain unchanged on
success and rejection. Injected observations are not live queries, and matching
attempt IDs do not establish freshness, build-source correspondence, provenance,
readiness or permission. Network adapters and live recovery evidence remain pending.

```sh
node --test test/release-publication-attempt.test.mjs
```

## Related policies

- [Security policy](../SECURITY.md) for vulnerability reporting and supported-version security fixes.
- [Installation guide](./INSTALLATION.md) for installation methods.
- [Engram Cloud quickstart](./engram-cloud/quickstart.md) for Cloud deployment guidance.

### Injected destination query coordinator (offline-tested seam)

`release/destination-probes.mjs` exports asynchronous
`probeAndPlanPublicationAttempt({ attemptId, version, artifacts, gates, queries })`.
`queries.npm` and `queries.core` are caller-provided IO functions. Each receives
one frozen `{ attemptId, version, destination }` request per valid invocation,
including repeated attempts for the same version; no observation cache is used.
Candidate/artifact/attempt validation and all six gates run through the existing
planner before external queries. Both queries settle even if one throws.

Adapters must actually query the remote destination anew and return explicit
`absent`, `present` or `unknown` state. Present requires externally verified
`sourceCommit`, `contractDigest` and `contentDigest`; missing or unverifiable
identity is not absence. Never infer identity from a version or tag. The coordinator
copies returned observations and binds current attempt/version; optional echoed
`attemptId`, `version` or `destination` must match exactly or the result rejects.
Unknown, malformed, thrown or stale results block with no actions and bounded
`invalid-destination-observation:<destination>` reasons, never remote error text.
Valid identity mismatches retain the existing corrective-version requirement.
Inputs and returned adapter records are not mutated; no publication is executed.

This proves fresh callback invocation only, not authentic network queries,
source-build provenance or production readiness. Concrete npm/GitHub extraction
and live-query checks remain unimplemented; whole T3 closure is not established.
No new publication identity-carrier format is introduced (that format remains
separately deferred). Existing destinations without verifiable identity block.
The unresolved closure disposition remains parent-owned, not reassigned to T4.

From `plugin/pi`, run the socket-free, in-memory adapter checks:

```sh
node --test test/release-destination-probes.test.mjs
```

### Read-only CLI census adapters

`createDestinationCliQueries({ packageName, repository, run? })` in
`release/destination-cli-queries.mjs` supplies the coordinator's npm/core queries.
Import and construction execute nothing. Each valid query independently invokes
`npm view <packageName> versions --json` or
`gh api repos/<owner>/<repo>/releases --paginate --slurp`.
The default promisified `execFile` uses argument arrays, no shell, a 30-second
 timeout and 1 MiB output bound; it does not write environment or artifacts.
The injectable runner must reject command failures and return `{ stdout, stderr }`
on success. No stderr is parsed or exposed. No publication commands are issued.

Only a successful well-formed complete census establishes absence: npm accepts
one strict SemVer string or an array of strict SemVer strings; GitHub accepts an
array of pages, each an array of release objects with string `tag_name`.
Exact version / `v<version>` matches report presence without invented identity,
so existing releases still block at the coordinator. Errors (including E404,
authentication and network failures), bad JSON or census shapes report unknown.
Each response echoes the current request bindings; no results are cached.
This implements concrete command IO, superseding the earlier unimplemented-IO
note, but offline fixtures do not prove live freshness, equivalence or readiness.
Identity carriers and whole T3 acceptance remain unresolved; no live query was run.

From `plugin/pi`, run the offline fake-runner checks:

```sh
node --test test/release-destination-cli-queries.test.mjs
```

### Coordinated candidate preflight (not publication)

From a clean tagged checkout, with installed SDK/offline Go dependencies:

```sh
node plugin/pi/release/release-preflight.mjs --ref refs/tags/v0.2.0 --sdk-root /absolute/path/to/installed/pi-coding-agent --output /absolute/git-common/gentle-checks/new-preflight
```

Use the exact package version, not a corrective version chosen by this command.
The output must be new, with an existing parent under Git's common directory
`gentle-checks`; existing output and symlink escapes reject without replacement.
Full tracked/untracked cleanliness and the selected tag/HEAD/tree are checked.
Ref/package agreement rejects before subprocesses. The existing Pi validator
then runs with `refs/tags/pi-v<version>`: its successful actual single-pin and CLI
help checks prove installer/package equality. Only then is installerVersion
recorded as derived evidence, not as a caller-supplied installer assertion.

The executable runs `go test -json ./...`, `npm test` once (including package,
public membership and semantic tests via the validated default script), the
separate explicit SDK host test, real schema capture, then one candidate
`npm pack --ignore-scripts --json --pack-destination <output>/npm`. Missing SDK
or failed gates block; no dependencies are downloaded. The bounded process runner
uses argument arrays, no shell, a 20-minute timeout and 64 MiB output limit.
Only the named chunkcodec baseline failure with its diagnostic and no other
failures is accepted as `accepted-baseline-failure`, never Go PASS.

Capture consumption uses its single reported retained path, validates the source
binding and compares canonical manifest/identity bytes. SHA-256 freezes the exact
packed tarball and contract bytes after a final source check. Owned logs and
`preflight-evidence.json` retain command/exit/status/log-digest receipts on gate
failure; version, installer and prerequisite failures create no output. Ambient
credentials are not forwarded or printed. This is not signed provenance or proof
against transient source changes. Offline fake-runner tests are not evidence of
a successful real full preflight.

No core digest or trusted-publisher approval is synthesized. GoReleaser build,
frozen gh/Homebrew publication and identity transport remain the next unit;
serialized workflow/lock/recovery wiring remains the following unit. Destination
freshness, OIDC/provenance, pin migration and publication authorization remain
separate gates. This command does not activate the coordinated release workflow.

### Frozen coordinated publisher (offline-tested executable)

The publisher adds executable delivery and identity transport to the earlier pure
helpers; it does not activate a workflow or prove a real release is ready.
Its exact help is:

```text
Usage: node plugin/pi/release/release-publisher.mjs --config <absolute JSON configuration path>
```

`runReleasePublisher(config, { root, run?, env? })` is the public function.
The CLI reads the same JSON configuration. Required fields are `version`, `ref`
(full `refs/tags/v<version>`), `attemptId` (unique alphanumeric/underscore/hyphen,
1–96 characters), `source: { commit, tree }` (full Git IDs), `preflightDirectory`,
`coreDirectory`, `coreAssets: [{ name, path }]`, `formulaPath`, `repository`
(`owner/name`), `packageName`, and externally confirmed `trustedPublisher: true`.
No secrets or extra keys belong in JSON. All filesystem inputs are absolute,
canonical, nonsymlink paths. Preflight must be under Git-common `gentle-checks`;
core files must be under the checkout or that owned directory. Explicitly list
six `engram_<version>_<linux|darwin|windows>_<amd64|arm64>` archives (Windows
`.zip`, others `.tar.gz`) plus `checksums.txt`; provide generated `engram.rb`
separately. Checksums must bind exactly those six archive bytes.

The caller builds once with GoReleaser OSS `release --skip=publish,announce,after
--clean`, configuring generated-formula `skip_upload: true` for that build only.
The original stable/prerelease `brews.skip_upload: auto` policy is retained:
this publisher delivers the generated formula only for stable releases. It never
rebuilds core, repacks the local npm candidate, changes formats/installers, or
requires Pro. The following workflow unit still owns core build/config wiring.

Before remote mutation, the publisher verifies clean HEAD/tree/tag, passed
source/version-bound preflight receipts (including the explicit Go baseline FAIL
exception), canonical contract bytes and exact candidate tarball SHA-256.
Artifacts freeze exclusively once under `gentle-checks/publisher-<attemptId>`.
New attempts need new IDs; frozen files/caches remain for operator inspection.
A fresh npm version census and paginated GitHub release census include drafts;
errors are unknown, never absence. Present npm requires a fresh remote-only
`npm pack <package>@<version> --ignore-scripts --json --pack-destination <owned>`
and exact tarball digest. Every core asset is downloaded through `gh api` as
binary bytes. No HTTP client or shell interpolates commands.

`engram-release-identity.json` is canonical JSON plus LF with schema
`engram.release-identity/v1`, version, full source commit/tree, contract/npm/core
digests, and base64 exact contract/core-manifest bytes. Formula bytes are a normal
core-manifest asset; the carrier excludes itself. Matching version presence is
not identity. Missing legacy carriers, unresolved target branches, incomplete
published assets or unknown observations block without delivery actions; valid
immutable mismatches require an operator-selected corrective version.

For a new version, a GitHub **draft identity reservation** and carrier are created
before npm staging. This is metadata, not published core artifacts. npm-only
recovery uses that fresh draft carrier; a draft is always core-absent. Delivery
then follows the existing planner: exact npm tarball under `staging-<version>`
with provenance/public access, exact frozen core uploads without clobber and
publication of the draft, then npm promotion to stable `latest` or prerelease
`next`. Stable Homebrew delivery occurs before promotion: a successful accessible
repository/directory census proves file absence; existing files are SHA-checked,
identical bytes are a no-op, and updates use the current Git blob SHA. Unknown,
404/auth failures and concurrent SHA failures stop; none imply absence.

Environment gates: `GH_TOKEN` for the release repository;
`ACTIONS_ID_TOKEN_REQUEST_URL` and `ACTIONS_ID_TOKEN_REQUEST_TOKEN` for OIDC
staging, together with GitHub provenance metadata (`GITHUB_ACTIONS`, repository,
server URL, SHA/ref, run ID/attempt, workflow ref/name and runner environment)
forwarded only to staging; `NPM_PROMOTION_TOKEN` for dist-tag writes; stable releases additionally
need `HOMEBREW_TAP_TOKEN`. The tap token reaches only tap gh calls; promotion
credentials reach only dist-tag commands. Owned npm configuration references
`${NODE_AUTH_TOKEN}` without storing its value; staging receives no static npm
credential. Token presence is not proof of authorization: trusted-publisher,
OIDC/provenance, repository/tap access and npm metadata-write setup must be
externally verified. No claim is made that dist-tag writes support OIDC alone.

Results expose bounded reasons, completed steps and the latest `durablePoint`,
never subprocess stdout/stderr or secrets. Errors stop immediately without
retries, overwrite, deletion or automatic rollback. Resume uses a new attempt
and fresh observations; a carrier-less interrupted reservation requires operator
intervention. CLI success prints `release publication completed`; failure exits
1 with only `release publication blocked or failed` on stderr (both plus LF).
Per-version workflow concurrency, real source/build equivalence, managed pins,
publication permission and live readiness remain separate gates, not proven by
fake CLI tests. Focused offline check from `plugin/pi`:

```sh
node --test test/release-publisher.test.mjs
```

### Active coordinated workflow wiring (supersedes earlier future/independent-route notes)

Core `v*` pushes and manual `release_ref=refs/tags/vSEMVER` use one per-ref workflow lock, without cancellation. Branches, shorthand and Pi tags reject. The legacy Pi workflow is validation-only; it neither publishes nor requests OIDC. `node .github/scripts/coordinated-release.mjs --help` describes the driver environment; from `plugin/pi`, run `node --test test/release-workflow.test.mjs` for offline wiring checks.

Operators must pin `vars.ENGRAM_PI_SDK_VERSION` to a strict SDK SemVer and set `vars.ENGRAM_TRUSTED_PUBLISHER_CONFIRMED` to exactly `true` only after verifying npm trusted-publisher setup. Missing/invalid values block. Go 1.25.10, Node 24 and npm >=11.5.1 are prepared by the workflow. The driver checks clean HEAD/tag/tree, runs `go mod tidy -diff` then `go mod download`, installs only that pinned SDK under Git-common `gentle-checks`, and invokes the actual preflight CLI once with its installed SDK root. Failed preflight never reaches GoReleaser or publication.

The owned generated GoReleaser config preserves the original configuration and macOS hook, changing only top-level `dist` and local `brews.skip_upload` to `true`. GoReleaser v2.13.2's documented relative `dist` customization (`www/docs/customization/dist.md`) is used with checkout-root cwd; its canonical resolution must equal the fresh owned core directory. No absolute GoReleaser path support or release `--dist` flag is assumed. The publisher instead receives absolute canonical filesystem paths. The sole core build runs OSS `release --skip=publish,announce,after --clean --config <owned-config>`; bounded nonsymlink enumeration selects six archives, checksums and exactly one formula, without scanning source/dependencies. Source and receipt bytes are rechecked before the existing publisher CLI freezes and delivers them, including stable-only Homebrew behavior.

Job-level contents-write/id-token-write authority is required for the combined publisher CLI; GitHub does not grant per-command permissions. Build/setup subprocesses receive no tap, promotion or OIDC credentials; publisher subprocess isolation remains authoritative. Run ID plus attempt identifies fresh owned state. Failures retain it for inspection and print only `coordinated release failed` with exit 1; success prints `coordinated release completed` with exit 0. Resume requires a new workflow attempt and fresh destination probes, not overwrite. Fake tests prove wiring, not hosted execution, provenance, destination equivalence, version/pin readiness or publication permission. Managed-pin migration remains T5.
