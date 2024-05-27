import { getSecret } from '@aws-lambda-powertools/parameters/secrets';
import { Octokit } from 'octokit';
import { CacheClient, Configurations, CredentialProvider } from '@gomomento/sdk';

let octokit;
let secrets;

export const getOctokit = async () => {
  if (!octokit) {
    const auth = await getSecretValue('github');
    octokit = new Octokit({ auth });
  }

  return octokit;
};

export const getSecretValue = async (key) => {
  await loadSecrets();
  return secrets[key];
};

export const getFileContents = async (fileName) => {
  if(!octokit){
    await getOctokit();
  }
  
  const contents = await octokit.request('GET /repos/{owner}/{repo}/contents/{path}', {
    owner: process.env.OWNER,
    repo: process.env.REPO,
    path: fileName
  });

  const buffer = Buffer.from(contents.data.content, 'base64');
  const data = buffer.toString('utf8');

  return data;
};

export const getCacheClient = async () => {
  if (!cacheClient) {
    const authToken = await getSecretValue('momento');

    cacheClient = new CacheClient({
      configuration: Configurations.Lambda.latest(),
      credentialProvider: CredentialProvider.fromString({ authToken }),
      defaultTtlSeconds: 3600
    });
  }

  return cacheClient;
};

const loadSecrets = async () => {
  if (!secrets) {
    secrets = await getSecret(process.env.SECRET_ID, { transform: 'json' });
  }
};
