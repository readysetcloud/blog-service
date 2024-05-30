import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';
import frontmatter from '@github-docs/frontmatter';
import { getOctokit, getFileContents } from './utils/helpers.mjs';

const eventBridge = new EventBridgeClient();
let octokit;

export const handler = async (event) => {
  try {
    octokit = await getOctokit();
    const recentCommits = await getRecentCommits();
    if (event.commits) {
      event.commits.map(c => recentCommits.push(c));
    }
    if (recentCommits.length) {
      const newContent = await getNewContent(recentCommits);
      if (newContent.length) {
        const data = await getContentData(newContent);
        await processNewContent(data);
      }
    }
  } catch (err) {
    console.error(err);
  }
};

const getRecentCommits = async () => {
  const timeTolerance = Number(process.env.COMMIT_TIME_TOLERANCE_MINUTES);
  const date = new Date();
  date.setMinutes(date.getMinutes() - timeTolerance);

  const result = await octokit.rest.repos.listCommits({
    owner: process.env.OWNER,
    repo: process.env.REPO,
    path: 'content/blog',
    since: date.toISOString()
  });

  const newPostCommits = result.data.filter(c => c.commit.message.toLowerCase().startsWith('[blog]'));
  return newPostCommits.map(d => d.sha);
};

const getNewContent = async (commits) => {
  const newContent = await Promise.allSettled(commits.map(async (commit) => {
    const commitDetail = await octokit.rest.repos.getCommit({
      owner: process.env.OWNER,
      repo: process.env.REPO,
      ref: commit
    });
    const newFiles = commitDetail.data.files.filter(f => ['added', 'renamed']
      .includes(f.status) && f.filename.startsWith('content/blog/'));

    return newFiles.map(p => {
      return {
        fileName: p.filename,
        commit: commit
      };
    });
  }));

  let content = [];
  for (const result of newContent) {
    if (result.status == 'rejected') {
      console.error(result.reason);
    } else {
      content = [...content, ...result.value];
    }
  }

  return content;
};

const getContentData = async (newContent) => {
  const contentData = await Promise.allSettled(newContent.map(async (content) => {
    const data = await getFileContents(content.fileName);
    return {
      fileName: content.fileName,
      commit: content.commit,
      content: data
    };
  }));

  let allContent = [];
  for (const result of contentData) {
    if (result.status == 'rejected') {
      console.error(result.reason);
    } else {
      allContent.push(result.value);
    }
  }

  return allContent;
};

const processNewContent = async (newContent) => {
  const today = new Date();
  const executions = await Promise.allSettled(newContent.map(async (content) => {
    const metadata = frontmatter(content.content);
    let postDate = metadata.data.date;
    if (!postDate.includes('T')) {
      postDate = `${postDate}T23:59:59`;
    }

    const date = new Date(postDate);
    if (date > today) {
      content.futureDate = `${metadata.data.date.split('T')[0]}T12:00:00Z`;
    }

    await eventBridge.send(new PutEventsCommand({
      Entries: [
        {
          Source: 'rsc.identify-new-blog',
          DetailType: 'Process New Blog',
          Detail: JSON.stringify({
            fileName: content.fileName,
            commit: content.commit,
            url: `/blog/${metadata.data.slug.substring(1)}`,
            author: metadata.data.author,
            ...content.futureDate && { futureDate: content.futureDate }
          })
        }
      ]
    }));
  }));

  for (const execution of executions) {
    if (execution.status == 'rejected') {
      console.error(execution.reason);
    }
  }
};
