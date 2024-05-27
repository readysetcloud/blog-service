import { SortedSetOrder, CacheSortedSetFetch } from '@gomomento/sdk';
import { getCacheClient } from './utils/helpers.mjs';

let cacheClient;

export const handler = async (state) => {
  cacheClient = await getCacheClient();

  const results = await Promise.all([
    await getTopResults(state.top, 'totalcounts', 'Overall'),
    await getTopResults(state.top, 'blogcounts', 'Ready, Set, Cloud!'),
    await getTopResults(state.top, 'mediumcounts', 'Medium'),
    await getTopResults(state.top, 'devcounts', 'Dev.to'),
    await getTopResults(state.top, 'hashnodecounts', 'Hashnode'),
  ]);

  const emailHtml = formatTopArticleEmail(results);

  return { emailHtml };
};

const getTopResults = async (top, sortedSetName, displayName) => {
  let topArticles = [];
  const response = await cacheClient.sortedSetFetchByRank('chatgpt', sortedSetName, {
    order: SortedSetOrder.Descending,
    startRank: 0,
    endRank: top
  });

  if (response instanceof CacheSortedSetFetch.Hit) {
    topArticles = response.valueArray().map(item => {
      return {
        slug: item.value,
        views: item.score
      };
    });
  }

  return { source: displayName, topArticles };
};

const formatTopArticleEmail = (topArticlesBySource) => {
  const emailHtml = `
    <html>
      <head>
        <style>
          table {
            border-collapse: collapse;
          }
          th, td {
            padding: 8px;
            text-align: left;
            border-bottom: 1px solid #ddd;
          }
        </style>
      </head>
      <body>
        <h1> Top articles for the week! </h1>
        ${topArticlesBySource.map(generateEmailTable).join('')}
      </body>
    </html>
  `;

  return emailHtml;
};

const generateEmailTable = (data) => {
  const { source, topArticles } = data;

  const tableRows = topArticles.map((article) => {
    const { slug, views } = article;
    return `<tr>
              <td>${slug}</td>
              <td>${views}</td>
            </tr>`;
  }).join('');

  const tableHtml = `
    <h2>${source}</h2>
    <table>
      <thead>
        <tr>
          <th>Article</th>
          <th>Views</th>
        </tr>
      </thead>
      <tbody>
        ${tableRows}
      </tbody>
    </table>
  `;

  return tableHtml;
};
