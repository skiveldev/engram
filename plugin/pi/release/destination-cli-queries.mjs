import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { assertReleaseVersionAgreement } from './version-contract.mjs';

const defaultExecFile = promisify(execFile);
function validateVersion(version) {
  assertReleaseVersionAgreement({ route: 'core', packageVersion: version,
    installerVersion: version, releaseRef: `refs/tags/v${version}` });
}
const clean = value => typeof value === 'string' && !/[\s\x00-\x1f\x7f]/.test(value);

/** Read-only complete destination censuses; presence is not identity evidence. */
export function createDestinationCliQueries({ packageName, repository, run = defaultExecFile } = {}) {
  const name = '[a-z0-9][a-z0-9._-]*';
  if (!clean(packageName) || packageName.length > 214 ||
      !new RegExp(`^(?:${name}|@${name}/${name})$`).test(packageName))
    throw new Error('Invalid npm package name');
  const component = '[A-Za-z0-9][A-Za-z0-9_.-]*';
  if (!clean(repository) || !new RegExp(`^${component}/${component}$`).test(repository))
    throw new Error('Invalid repository owner/name');
  if (typeof run !== 'function') throw new Error('run must be a function');

  function query(destination) {
    return async request => {
      if (!request || request.destination !== destination ||
          typeof request.attemptId !== 'string' || !request.attemptId.trim())
        throw new Error('Invalid destination query request');
      validateVersion(request.version);
      const echo = { destination, version: request.version, attemptId: request.attemptId };
      try {
        const args = destination === 'npm' ? ['view', packageName, 'versions', '--json'] :
          ['api', `repos/${repository}/releases`, '--paginate', '--slurp'];
        const { stdout } = await run(destination === 'npm' ? 'npm' : 'gh', args,
          { shell: false, timeout: 30000, maxBuffer: 1048576 });
        const census = JSON.parse(stdout);
        let present;
        if (destination === 'npm') {
          const versions = typeof census === 'string' ? [census] : census;
          if (!Array.isArray(versions)) throw new Error('Invalid version census');
          versions.forEach(validateVersion);
          present = versions.includes(echo.version);
        } else {
          if (!Array.isArray(census) || !census.every(page => Array.isArray(page) &&
              page.every(release => release && typeof release === 'object' &&
                !Array.isArray(release) && typeof release.tag_name === 'string')))
            throw new Error('Invalid release census');
          present = census.some(page => page.some(release => release.tag_name === `v${echo.version}`));
        }
        return { ...echo, state: present ? 'present' : 'absent' };
      } catch {
        return { ...echo, state: 'unknown' };
      }
    };
  }
  return { npm: query('npm'), core: query('core') };
}
