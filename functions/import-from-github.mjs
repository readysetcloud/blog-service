import { SFNClient, StartExecutionCommand } from '@aws-sdk/client-sfn';
import frontmatter from '@github-docs/frontmatter';
import { getOctokit, getTenant, getFileContents } from './utils/helpers.mjs';

const sfn = new SFNClient();
let octokit;

export const handler = async (event) => {
  try {
    const { github, tenantId } = event.detail;
    const tenant = await getTenant(tenantId);
    octokit = await getOctokit(tenantId);

    const data = await getFileContents(tenantId, github);
    const blogData = {
      fileName: github.fileName,
      tenant: {
        id: tenant.pk,
        email: tenant.email
      },
      key: `${tenant.pk}#${github.fileName}`,
      content: data
    };

    await processNewBlog(blogData);

  } catch (err) {
    console.error(err);
  }
};

const processNewBlog = async (data) => {
  const today = new Date();
  const metadata = frontmatter(data.content);
  let postDate = metadata.data.date;
  if (postDate.toISOString().indexOf('T00:00:00.000Z') > -1) {
    postDate = `${postDate.toISOString().split('T')[0]}T12:00:00Z`;
  }

  const date = new Date(postDate);
  if (date > today) {
    data.futureDate = `${metadata.data.date.toISOString().split('T')[0]}T12:00:00Z`;
  }
  const crossPostTo = metadata.data.crosspost ?? [];
  data.crossPostTo = crossPostTo;
  data.url = `/blog/${metadata.data.slug.substring(1)}`;
  data.shouldPublish = Boolean(process.env.SHOULD_PUBLISH);

  await sfn.send(new StartExecutionCommand({
    stateMachineArn: process.env.STATE_MACHINE_ARN,
    input: JSON.stringify(data)
  }));
};
