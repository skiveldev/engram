import { assertReleaseVersionAgreement } from "./version-contract.mjs";

const commit = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const digest = /^[a-f0-9]{64}$/;
const gates = ["goTests", "piTests", "packageChecks", "profileParity", "semanticContract", "trustedPublisher"];
const record = value => value !== null && typeof value === "object" && !Array.isArray(value);
const blocked = (reason, correctiveVersionRequired = false) => ({
	status: "blocked", reason, correctiveVersionRequired, actions: [],
});
const identityValid = value => record(value) && typeof value.sourceCommit === "string" &&
	commit.test(value.sourceCommit) && typeof value.contractDigest === "string" &&
	digest.test(value.contractDigest) && typeof value.contentDigest === "string" && digest.test(value.contentDigest);

/**
 * Plan from verified snapshot evidence only; never probe, publish or mutate input.
 * Digests are lowercase SHA-256: contract bytes, npm tarball, core artifact manifest.
 * A ready plan is not publication permission or proof of fresh destination state.
 */
export function planPublication(input) {
	if (!record(input) || !record(input.candidate)) return blocked("invalid-evidence");
	const candidate = input.candidate;
	try {
		assertReleaseVersionAgreement({ route: "core", releaseRef: `refs/tags/v${candidate.version}`,
			packageVersion: candidate.version, installerVersion: candidate.version });
	} catch {
		return blocked("invalid-evidence");
	}
	for (const destination of ["npm", "core"]) {
		if (!identityValid({ ...candidate, contentDigest: candidate[`${destination}Digest`] })) {
			return blocked("invalid-evidence");
		}
	}

	for (const destination of ["npm", "core"]) {
		const observed = input.destinations?.[destination];
		if (observed === undefined || (record(observed) && observed.state === "unknown")) {
			return blocked(`unverified-destination:${destination}`);
		}
		if (!record(observed) || !["absent", "present"].includes(observed.state)) return blocked("invalid-evidence");
		if (observed.state === "present") {
			if (!identityValid(observed)) return blocked("invalid-evidence");
			if (observed.sourceCommit !== candidate.sourceCommit || observed.contractDigest !== candidate.contractDigest ||
				observed.contentDigest !== candidate[`${destination}Digest`]) {
				return blocked(`immutable-mismatch:${destination}`, true);
			}
		}
	}
	for (const gate of gates) {
		if (input.gates?.[gate] !== true) return blocked(`unverified-gate:${gate}`);
	}

	const actions = [input.destinations.npm.state === "absent" ? "publish-npm-staging" : "set-npm-staging-tag"];
	if (input.destinations.core.state === "absent") actions.push("publish-core");
	actions.push("promote-npm");
	return {
		status: "ready", version: candidate.version, stagingTag: `staging-${candidate.version}`,
		promotionTag: candidate.version.split("+")[0].includes("-") ? "next" : "latest", actions,
	};
}
