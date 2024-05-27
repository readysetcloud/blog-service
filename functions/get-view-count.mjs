import { BetaAnalyticsDataClient } from '@google-analytics/data';
import { getSecretValue } from './utils/helpers.mjs';
import fs from 'fs';
import zlib from 'zlib';

let cachedHashnodeArticles;
let cachedRSCArticles;

export const handler = async (state) => {
  let ids = state.ids;
  if (state.unmarshallIds) {
    ids = {
      ...ids.M.mediumId && { mediumId: ids.M.mediumId.S },
      ...ids.M.devId && { devId: ids.M.devId.S },
      ...ids.M.hashnodeId && { hashnodeId: ids.M.hashnodeId.S }
    };
  }

  const allViews = await Promise.all([
    await getRSCData(state.blog),
    await getMediumData(ids.mediumId),
    await getDevData(ids.devId),
    await getHashnodeData(ids.hashnodeId)
  ]);

  const views = {
    blog: allViews[0],
    medium: allViews[1],
    dev: allViews[2] ?? 0,
    hashnode: allViews[3] ?? 0,
  };

  let total = 0;
  allViews.map(views => { if (views) { total += views; } });
  views.total = total;

  return views;
};

const getMediumData = async (id) => {
  try {
    const auth = await getSecretValue('medium-cookie');
    const config = {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Cookie': auth
      },
      body: JSON.stringify([
        {
          operationName: "StatsPostReferrersContainer",
          variables: {
            postId: id
          },
          query: "query StatsPostReferrersContainer($postId: ID!) { post(id: $postId) { totalStats { views }}}"
        }
      ])
    };

    const response = await fetch('https://medium.com/_/graphql', config);
    const jsonResponse = await response.json();
    const data = jsonResponse[0].data.post;
    return data.totalStats.views;
  } catch (err) {
    console.error('Error fetching medium data');
    console.error(err);
    if (err.response?.status == 429) {
      function CustomError(message) {
        this.name = 'RateLimitExceeded';
        this.message = message;
      }

      CustomError.prototype = new Error();
      console.log('Throwing RateLimitExceededError');
      throw new CustomError(err.message);
    }
  }
};

const getDevData = async (id) => {
  if (!id) return;

  try {
    const auth = await getSecretValue('dev');
    const url = `https://dev.to/api/analytics/historical?start=2019-04-01&article_id=${id}`;
    const config = {
      method: 'GET',
      headers: {
        'api-key': auth,
        'Accept': 'application/vnd.forem.api-v1+json'
      }
    };

    const response = await fetch(url, config);
    const jsonResponse = await response.json();
    let views = 0;
    for (const [date, data] of Object.entries(jsonResponse)) {
      views += data.page_views.total;
    }

    return views;
  } catch (err) {
    console.error('Error fetching dev data');
    console.error(err);
  }
};

const getHashnodeData = async (id) => {
  if (!id) return;

  try {
    let hashnodeArticles = [];
    if (cachedHashnodeArticles) {
      hashnodeArticles = cachedHashnodeArticles;
    } else {
      const auth = await getSecretValue('hashnode');
      let page = 0;
      let hasMorePages = true;
      const hashnodeArticles = [];

      while (hasMorePages) {
        const url = `https://hashnode.com/ajax/user/post-stats?publication=626beb20b7dcabd258e7436c&page=${page}`;
        const config = {
          method: 'GET',
          headers: {
            'Authorization': auth
          }
        };

        try {
          const response = await fetch(url, config);
          const jsonResponse = await response.json();
          const posts = jsonResponse.posts;

          hasMorePages = posts.length > 0;
          posts.forEach(post => {
            hashnodeArticles.push({
              slug: post.slug,
              views: post.views
            });
          });

          page += 1;
        } catch (error) {
          console.error('Error fetching data:', error);
          hasMorePages = false;
        }
      }

      cachedHashnodeArticles = hashnodeArticles;
    }

    const article = hashnodeArticles.find(ha => ha.slug == id);
    return article ? Number(article.views) : 0;
  } catch (err) {
    console.error('Error fetching Hashnode data');
    console.error(err);
  }
};

const getRSCData = async (id) => {
  try {
    let articles = [];
    if (cachedRSCArticles) {
      articles = cachedRSCArticles;
    } else {
      if (!fs.existsSync('/tmp/credentials.json')) {
        const credData = await getSecretValue('ga');
        const compressedData = Buffer.from(credData, 'base64');
        const decompressedData = zlib.inflateSync(compressedData);
        const originalString = decompressedData.toString();

        fs.writeFileSync('/tmp/credentials.json', originalString);
      }

      const analyticsDataClient = new BetaAnalyticsDataClient({
        keyFile: '/tmp/credentials.json'
      });

      let propertyId = '363019578';
      const [response] = await analyticsDataClient.runReport({
        property: 'properties/' + propertyId,
        dateRanges: [
          {
            startDate: '2019-04-01',
            endDate: 'today',
          }
        ],
        dimensions: [
          {
            name: 'pagePath',
          }
        ],
        dimensionFilter: {
          filter: {
            fieldName: 'pagePath',
            stringFilter: {
              matchType: 'BEGINS_WITH',
              value: '/blog/',
              caseSensitive: false
            }
          }
        },
        metrics: [
          {
            name: 'screenPageViews',
          },
        ],
      });

      for (const row of response.rows) {
        articles.push({
          slug: row.dimensionValues[0].value,
          views: row.metricValues[0].value
        });
      }

      cachedRSCArticles = articles;
    }

    const article = articles.find(p => p.slug.includes(id));
    return article ? Number(article.views) : 0;
  } catch (err) {
    console.error('Error fetching Ready, Set, Cloud data');
    console.error(err);
  }
};
