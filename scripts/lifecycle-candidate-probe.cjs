const fs = require('node:fs');
const path = require('node:path');

async function Run() {
  const resources = process.env.OFFERGET_INSTALLED_RESOURCES;
  const workspacePath = process.env.OFFERGET_LIFECYCLE_WORKSPACE;
  const resultPath = process.env.OFFERGET_LIFECYCLE_RESULT;
  const expectation = process.env.OFFERGET_LIFECYCLE_EXPECTATION;
  if (![resources, workspacePath, resultPath, expectation].every(Boolean)) throw new Error('Candidate probe environment is incomplete.');
  const { BusinessStore } = require(path.join(resources, 'app.asar', 'apps', 'backend', 'dist', 'business-store.js'));
  let opened = false;
  let rejected = false;
  let store;
  try {
    store = new BusinessStore(workspacePath);
    opened = true;
  } catch {
    rejected = true;
  } finally {
    store?.Close();
  }
  const result = { opened, rejected, expectation, passed: expectation === 'open-v4' ? opened && !rejected : rejected && !opened };
  fs.writeFileSync(resultPath, JSON.stringify(result), 'utf8');
  console.log(JSON.stringify(result));
  if (!result.passed) process.exitCode = 1;
}

Run().catch((error) => { console.error(error); process.exitCode = 1; });
