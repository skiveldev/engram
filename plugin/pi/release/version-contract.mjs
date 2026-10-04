// SemVer 2.0 identifiers stay strings: numeric components have no size limit.
const numeric = "(?:0|[1-9][0-9]*)";
const prereleaseId = `(?:${numeric}|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)`;
const buildId = "[0-9A-Za-z-]+";
const semver = new RegExp(
	`^${numeric}\\.${numeric}\\.${numeric}` +
	`(?:-${prereleaseId}(?:\\.${prereleaseId})*)?` +
	`(?:\\+${buildId}(?:\\.${buildId})*)?(?![\\s\\S])`,
);

function assertSemVer(version, field) {
	if (typeof version !== "string" || !semver.test(version)) {
		throw new Error(`${field} must be a canonical SemVer 2.0 string`);
	}
}

/**
 * Pure release agreement check; no file reads, publication or version selection.
 * The core route is a future train capability, not an active workflow switch.
 * Omit piMetadataVersion when unavailable; a supplied value must be valid.
 * Returns the exact agreed version (including build metadata), or throws.
 */
export function assertReleaseVersionAgreement(input) {
	const { route, releaseRef, packageVersion, installerVersion } = input;
	if (route !== "core" && route !== "pi") {
		throw new Error('Release route must be explicitly "core" or "pi"');
	}

	assertSemVer(packageVersion, "packageVersion");
	assertSemVer(installerVersion, "installerVersion");
	if (installerVersion !== packageVersion) {
		throw new Error(`installerVersion ${installerVersion} must match package version ${packageVersion}`);
	}
	if (Object.hasOwn(input, "piMetadataVersion")) {
		assertSemVer(input.piMetadataVersion, "piMetadataVersion");
		if (input.piMetadataVersion !== packageVersion) {
			throw new Error(`piMetadataVersion ${input.piMetadataVersion} must match package version ${packageVersion}`);
		}
	}

	const prefix = route === "core" ? "v" : "pi-v";
	const expectedRef = `refs/tags/${prefix}${packageVersion}`;
	// Exact equality to a validated version also rejects shorthand and branch refs.
	if (releaseRef !== expectedRef) {
		throw new Error(`Release ref ${JSON.stringify(releaseRef)} must match package version tag ${expectedRef}`);
	}
	return packageVersion;
}
