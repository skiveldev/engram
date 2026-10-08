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
