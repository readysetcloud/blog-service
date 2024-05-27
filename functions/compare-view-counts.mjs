import { getCacheClient } from "./utils/helpers.mjs";

export const handler = async (state) => {
  const blog = getViewCountChange(state.views.blog, state.previous?.M?.blog?.N);
  const medium = getViewCountChange(state.views.medium, state.previous?.M?.medium?.N);
  const dev = getViewCountChange(state.views.dev, state.previous?.M?.dev?.N);
  const hashnode = getViewCountChange(state.views.hashnode, state.previous?.M?.hashnode?.N);
  const total = getViewCountChange(state.views.total, state.previous?.M?.total?.N);

  const cacheClient = await getCacheClient();
  await Promise.all([
    await cacheClient.sortedSetPutElement('chatgpt', 'blogcounts', state.blog, blog),
    await cacheClient.sortedSetPutElement('chatgpt', 'mediumcounts', state.blog, medium),
    await cacheClient.sortedSetPutElement('chatgpt', 'devcounts', state.blog, dev),
    await cacheClient.sortedSetPutElement('chatgpt', 'hashnodecounts', state.blog, hashnode),
    await cacheClient.sortedSetPutElement('chatgpt', 'totalcounts', state.blog, total),
  ]);

  return {
    blog,
    medium,
    dev,
    hashnode,
    total
  };
};

const getViewCountChange = (current, previous) => {
  const currentNumber = Number(current) || 0;
  const previousNumber = Number(previous) || 0;

  return currentNumber - previousNumber;
};
