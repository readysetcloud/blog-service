import { getSecret } from '@aws-lambda-powertools/parameters/secrets';
import { Octokit } from 'octokit';
import { CacheClient, Configurations, CredentialProvider } from '@gomomento/sdk';
import { DynamoDBClient, GetItemCommand } from '@aws-sdk/client-dynamodb';
import { marshall, unmarshall} from '@aws-sdk/util-dynamodb';

let octokit;
let secrets;
let tenants = {};
const ddb = new DynamoDBClient();

export const getOctokit = async (tenantId) => {
  if (!octokit) {
    let secrets;
    if (tenantId) {
      const tenant = await getTenant(tenantId);
      secrets = await getParameter(tenant.apiKeyParameter, { decrypt: true, transform: 'json' });
    } else {
      secrets = await getSecret(process.env.SECRET_ID, { transform: 'json' });
    }

    const auth = secrets.github;
    octokit = new Octokit({ auth });
  }

  return octokit;
};

export const getSecretValue = async (key) => {
  await loadSecrets();
  return secrets[key];
};

export const getFileContents = async (tenantId, github) => {
  if(!octokit){
    await getOctokit();
  }
  const tenant = await getTenant(tenantId);
  const contents = await octokit.request('GET /repos/{owner}/{repo}/contents/{path}', {
    owner: tenant.github.owner,
    repo: tenant.github.repo,
    path: github.fileName,
    ...github.branchName && { ref: github.branchName }
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


export const getTenant = async (tenantId) => {
  if (tenants.tenantId) {
    return tenants.tenantId;
  } else {
    const result = await ddb.send(new GetItemCommand({
      TableName: process.env.TABLE_NAME,
      Key: marshall({
        pk: tenantId,
        sk: 'tenant'
      })
    }));

    if (!result.Item) {
      throw new Error(`Tenant '${tenantId}' not found`);
    }

    const data = unmarshall(result.Item);
    tenants.tenantId = data;
    return data;
  }
};
