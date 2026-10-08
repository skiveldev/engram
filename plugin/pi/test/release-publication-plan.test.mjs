import assert from "node:assert/strict";
import { test } from "node:test";
import { planPublication } from "../release/publication-plan.mjs";

const sha = "a".repeat(64);
const gates = ["goTests", "piTests", "packageChecks", "profileParity", "semanticContract", "trustedPublisher"];
function input(version = "3.1.0") {
	return {
		candidate: { version, sourceCommit: "b".repeat(40), contractDigest: sha, npmDigest: sha, coreDigest: "c".repeat(64) },
		gates: Object.fromEntries(gates.map(name => [name, true])),
		destinations: { npm: { state: "absent" }, core: { state: "absent" } },
	};
}
function existing(candidate, destination) {
	return { state: "present", sourceCommit: candidate.sourceCommit, contractDigest: candidate.contractDigest,
		contentDigest: candidate[`${destination}Digest`] };
}
function check(value) {
	const before = structuredClone(value);
	const result = planPublication(value);
	assert.deepEqual(value, before, "planning must not change evidence");
	return result;
}
function blocked(value, reason, correctiveVersionRequired = false) {
	assert.deepEqual(check(value), { status: "blocked", reason, correctiveVersionRequired, actions: [] });
}

test("new stable release stages npm before core and promotes latest", () => {
	assert.deepEqual(check(input()), {
		status: "ready", version: "3.1.0", stagingTag: "staging-3.1.0", promotionTag: "latest",
		actions: ["publish-npm-staging", "publish-core", "promote-npm"],
	});
});

test("prereleases promote next; build metadata alone is stable", () => {
	for (const [version, tag] of [["3.1.0-rc.1", "next"], ["3.1.0-rc.1+build.2", "next"], ["3.1.0+build-2", "latest"]]) {
		assert.deepEqual(check(input(version)), {
			status: "ready", version, stagingTag: `staging-${version}`, promotionTag: tag,
			actions: ["publish-npm-staging", "publish-core", "promote-npm"],
		});
	}
});

test("resume skips each matching immutable destination without republishing", () => {
	for (const [npm, core, actions] of [
		[true, false, ["set-npm-staging-tag", "publish-core", "promote-npm"]],
		[false, true, ["publish-npm-staging", "promote-npm"]],
		[true, true, ["set-npm-staging-tag", "promote-npm"]],
	]) {
		const value = input();
		if (npm) value.destinations.npm = existing(value.candidate, "npm");
		if (core) value.destinations.core = existing(value.candidate, "core");
		assert.deepEqual(check(value), { status: "ready", version: "3.1.0", stagingTag: "staging-3.1.0", promotionTag: "latest", actions });
	}
});

test("each immutable identity mismatch requires a corrective version", () => {
	for (const destination of ["npm", "core"]) {
		for (const field of ["sourceCommit", "contractDigest", "contentDigest"]) {
			const value = input();
			value.destinations[destination] = existing(value.candidate, destination);
			value.destinations[destination][field] = "d".repeat(field === "sourceCommit" ? 40 : 64);
			blocked(value, `immutable-mismatch:${destination}`, true);
		}
	}
});

test("unknown or missing destination observations never mean absent", () => {
	for (const destination of ["npm", "core"]) {
		for (const observation of [undefined, { state: "unknown" }]) {
			const value = input();
			value.destinations[destination] = observation;
			blocked(value, `unverified-destination:${destination}`);
		}
	}
});

test("every gate must explicitly pass, including blocked parity and publisher readiness", () => {
	for (const gate of gates) {
		for (const evidence of [false, undefined, "true", 1]) {
			const value = input();
			value.gates[gate] = evidence;
			blocked(value, `unverified-gate:${gate}`);
		}
	}
	const value = input();
	delete value.gates;
	blocked(value, "unverified-gate:goTests");
});

test("invalid candidate or destination identity fails closed", () => {
	for (const value of [null, undefined, {}, [], input("v3.1.0"), input("3.01.0"), input("3.1.0\n")]) {
		blocked(value, "invalid-evidence");
	}
	for (const field of ["sourceCommit", "contractDigest", "npmDigest", "coreDigest"]) {
		for (const invalid of [undefined, "", "not-a-digest", "A".repeat(64), "a".repeat(field === "sourceCommit" ? 40 : 64) + "\n"]) {
			const value = input();
			value.candidate[field] = invalid;
			blocked(value, "invalid-evidence");
		}
	}
	for (const destination of ["npm", "core"]) {
		const value = input();
		value.destinations[destination] = { state: "present" };
		blocked(value, "invalid-evidence");
		value.destinations[destination] = { state: "missing" };
		blocked(value, "invalid-evidence");
	}
});

test("full SHA-256 Git commit identities are supported", () => {
	const value = input();
	value.candidate.sourceCommit = "b".repeat(64);
	value.destinations.npm = existing(value.candidate, "npm");
	assert.deepEqual(check(value), { status: "ready", version: "3.1.0", stagingTag: "staging-3.1.0", promotionTag: "latest",
		actions: ["set-npm-staging-tag", "publish-core", "promote-npm"] });
});
