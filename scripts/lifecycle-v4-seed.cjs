const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

async function Run() {
  const resources = process.env.AVERY_INSTALLED_RESOURCES;
  const workspacePath = process.env.AVERY_LIFECYCLE_WORKSPACE;
  const userDataPath = process.env.AVERY_LIFECYCLE_USER_DATA;
  const fixturePath = process.env.AVERY_LIFECYCLE_ATTACHMENT;
  const resultPath = process.env.AVERY_LIFECYCLE_RESULT;
  if (![resources, workspacePath, userDataPath, fixturePath, resultPath].every(Boolean)) throw new Error('Lifecycle v4 seed environment is incomplete.');
  const { CreateWorkerHost } = require(path.join(resources, 'app.asar', 'apps', 'backend', 'dist', 'worker-host.js'));
  const host = CreateWorkerHost({ workspacePath, userDataPath, smoke: true });
  try {
    await host.Ready();
    const business = host.business;
    await business.SaveSettings({ nickname: '上一候选用户', developerMode: false });
    await business.SaveProfiles([{ id: 'lifecycle-profile', category: 'project', title: '生命周期档案', content: '确定性测试内容', updatedAt: Date.now() }]);
    await business.UpsertResume({ id: 'lifecycle-resume', name: '生命周期简历', targetRoles: ['前端工程师'], summary: '第一版', content: '第一版正文' });
    await business.UpsertResume({ id: 'lifecycle-resume', name: '生命周期简历', targetRoles: ['前端工程师'], summary: '第二版', content: '第二版正文' });
    await business.UpsertJob({ id: 'lifecycle-job', company: '验收公司', title: '前端工程师', city: '上海', experience: '3年', employmentType: 'full_time', channel: 'company_website', favorite: true, jd: '确定性 JD' });
    await business.UpsertApplication({ id: 'lifecycle-application', jobId: 'lifecycle-job', resumeId: 'lifecycle-resume', status: 'applied', note: '生命周期验收' });
    await business.ImportAttachment(fixturePath, 'text/plain');
    await business.CreateBackup();
    const status = await business.GetStatus();
    const schema = await business.CaptureSchemaSnapshot();
    const view = await business.LoadViewModel();
    const profiles = await business.GetProfiles();
    const revisions = await business.GetResumeRevisions('lifecycle-resume');
    const attachmentSha256 = crypto.createHash('sha256').update(fs.readFileSync(fixturePath)).digest('hex');
    const result = {
      schemaVersion: Math.max(...schema.migrations.map((entry) => entry.version)),
      metadataSchemaVersion: status.metadata.schema_version,
      counts: { conversations: view.conversations.length, resumes: view.resumes.length, jobs: view.jobs.length, applications: view.applications.length, profiles: profiles.items.length },
      resumeRevision: view.resumes.find((item) => item.id === 'lifecycle-resume')?.revision,
      resumeRevisionCount: revisions.length,
      profileHash: profiles.hash,
      attachmentSha256,
      attachmentPreserved: fs.existsSync(path.join(workspacePath, 'attachments', attachmentSha256)),
      backupCreated: fs.readdirSync(path.join(workspacePath, 'backups')).some((name) => name.startsWith('daily-')),
    };
    fs.writeFileSync(resultPath, JSON.stringify(result), 'utf8');
    console.log(JSON.stringify(result));
  } finally {
    host.Close();
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
}

Run().catch((error) => { console.error(error); process.exitCode = 1; });
