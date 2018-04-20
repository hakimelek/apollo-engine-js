// Some test dependencies can't even be imported (due to use of async/await)
// with old Node versions. The easiest way to work around this for CI is for CI
// (the precircle npm script) to literally delete a test file in this case,
// because we can't do conditional imports in TypeScript.

const semver = require('semver');
const fs = require('fs');
const path = require('path');

function kill(file) {
  const p = path.join(__dirname, file);
  if (fs.existsSync(p)) {
    console.log('Deleting ' + p);
    fs.unlinkSync(p);
  }
}

if (semver.lt(process.version, '8.0.0')) {
  kill('engine-node8.test.ts');
}

if (semver.lt(process.version, '6.0.0')) {
  kill('engine-node6.test.ts');
}
