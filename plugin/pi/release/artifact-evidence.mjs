import { createHash } from 'node:crypto';
import { canonicalContract } from './canonical-contract.mjs';

const objectId = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const digest = /^[a-f0-9]{64}$/;
const matches = (pattern, value) => typeof value === 'string' && pattern.test(value);
const text = value => typeof value === 'string' && value.trim().length > 0;
const bytes = value => value instanceof Uint8Array;
const sha = value => createHash('sha256').update(value).digest('hex');
const invalidArtifact = () => { throw new TypeError('invalid artifact evidence'); };
const invalidObservation = () => { throw new TypeError('invalid destination observation'); };

/** Hash supplied bytes; no build, source inspection, provenance or publication authority. */
export function buildArtifactIdentity(input) {
  if (!matches(objectId, input?.source?.commit) || !matches(objectId, input?.source?.tree) ||
    !bytes(input.contractBytes) || !matches(digest, input.contractDigest) ||
    !bytes(input.npmBytes) || !Array.isArray(input.coreAssets) || input.coreAssets.length === 0)
    return invalidArtifact();
  try {
    const parsed = JSON.parse(Buffer.from(input.contractBytes).toString('utf8'));
    if (parsed.schema !== 'engram.canonical-contract/v1') return invalidArtifact();
    const { schema, ...evidence } = parsed;
    const canonical = canonicalContract(evidence);
    if (!canonical.bytes.equals(Buffer.from(input.contractBytes)) || canonical.digest !== input.contractDigest)
      return invalidArtifact();
  } catch { return invalidArtifact(); }
  const names = new Set();
  const coreAssets = input.coreAssets.map(asset => {
    if (!text(asset?.name) || names.has(asset.name) || !bytes(asset.bytes)) return invalidArtifact();
    names.add(asset.name);
    const computed = sha(asset.bytes);
    if (Object.hasOwn(asset, 'digest') && (!matches(digest, asset.digest) || asset.digest !== computed))
      return invalidArtifact();
    return { name: asset.name, digest: computed };
  }).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  const coreManifestBytes = Buffer.from(`${JSON.stringify({ schema: 'engram.core-assets/v1', assets: coreAssets })}\n`);
  return { sourceCommit: input.source.commit, sourceTree: input.source.tree,
    contractDigest: input.contractDigest, npmDigest: sha(input.npmBytes),
    coreDigest: sha(coreManifestBytes), coreAssets, coreManifestBytes };
}

/** Attempt binding validates adapter evidence, not whether a new query actually ran.
 * Valid immutable mismatches are retained for the publication planner to block.
 */
export function bindDestinationObservation(input) {
  const candidate = input?.candidate;
  const observed = input?.observation;
  if (!text(input?.attemptId) || !['npm', 'core'].includes(input.destination) ||
    !text(candidate?.version) || !matches(objectId, candidate.sourceCommit) ||
    !matches(objectId, candidate.sourceTree) || !matches(digest, candidate.contractDigest) ||
    !matches(digest, candidate.npmDigest) || !matches(digest, candidate.coreDigest) ||
    !observed || !['absent', 'present'].includes(observed.state) ||
    observed.attemptId !== input.attemptId || observed.version !== candidate.version)
    return invalidObservation();
  if (observed.state === 'present' && (!matches(objectId, observed.sourceCommit) ||
    !matches(digest, observed.contractDigest) || !matches(digest, observed.contentDigest)))
    return invalidObservation();
  return { ...observed };
}
