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
ENGRAM_PI_SDK_ROOT=/absolute/path/to/installed/pi-coding-agent node --test test/release-schema-capture.mjs
```

The explicit fixture loads actual plugin registrations with installed TypeBox
and TUI dependencies, not stubs. It captures 22 Pi schemas and the 19 actual MCP
`tools/list` records through the opt-in Go bridge. State, caches, logs and raw
`schema-capture.json` remain under Git's common directory at
`gentle-checks/t3-capture`; Go runs offline. This is registration-time schema
evidence, not Pi SDK session dispatch or host validation. Callback code is not
serialized. Full accepted dispositions, candidate/source binding and canonical
manifest integration are still required before this capture is release evidence.

## Related policies

- [Security policy](../SECURITY.md) for vulnerability reporting and supported-version security fixes.
- [Installation guide](./INSTALLATION.md) for installation methods.
- [Engram Cloud quickstart](./engram-cloud/quickstart.md) for Cloud deployment guidance.
