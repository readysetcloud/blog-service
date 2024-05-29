import frontmatter from '@github-docs/frontmatter';

export const handler = async (state) => {
  const details = frontmatter(state.post);
  const links = getLinks(details.content);
  const tweets = getTweets(details.content);

  let payload;
  switch (state.format.toLowerCase()) {
    case 'medium':
      payload = formatMediumData(details, state.catalog, links, tweets);
      break;
    case 'dev':
      payload = formatDevData(details, state.catalog, links, tweets);
      break;
    case 'hashnode':
      payload = formatHashnodeData(details, state.catalog, links, tweets);
      break;
  }
  return {
    payload,
    url: `/blog/${details.data.slug.substring(1)}`
  };
};

const formatMediumData = (postDetail, catalog, links, tweets) => {
  let mediumContent = `\n# ${postDetail.data.title}\n`
    + `#### ${postDetail.data.description}\n`
    + `![${postDetail.data.image_attribution ?? ''}](${postDetail.data.image})\n`
    + `${postDetail.content.slice(0)}`;

  mediumContent = mediumContent.replace(/\n\n## /g, '\n\n---\n\n## ');
  for (const link of links) {
    const replacement = catalog.find(c => c.links.M.url.S == link[1]);
    if (replacement) {
      if (replacement.links.M.medium.S) {
        mediumContent = mediumContent.replace(link[1], replacement.links.M.medium.S);
      } else {
        mediumContent = mediumContent.replace(link[1], `${process.env.BLOG_BASE_URL}${replacement.links.M.url.S}`);
      }
    }
  }

  for (const tweet of tweets) {
    const tweetUrl = getTweetUrl(tweet);
    mediumContent = mediumContent.replace(tweet[0], tweetUrl);
  }

  const mediumData = {
    title: postDetail.data.title,
    contentFormat: 'markdown',
    tags: [...postDetail.data.categories, ...postDetail.data.tags],
    canonicalUrl: `https://readysetcloud.io/blog/${postDetail.data.slug.substring(1)}`,
    publishStatus: 'draft',
    notifyFollowers: true,
    content: mediumContent
  };

  return mediumData;
};

const formatDevData = (postDetail, catalog, links, tweets) => {
  let devContent = postDetail.content.slice(0);
  for (const link of links) {
    const replacement = catalog.find(c => c.links.M.url.S == link[1]);
    if (replacement) {
      if (replacement.links.M.dev.S) {
        devContent = devContent.replace(link[1], replacement.links.M.dev.S);
      } else {
        devContent = devContent.replace(link[1], `${process.env.BLOG_BASE_URL}${replacement.links.M.url.S}`);
      }
    }
  }

  for (const tweet of tweets) {
    const tweetUrl = getTweetUrl(tweet);
    devContent = devContent.replace(tweet[0], `{% twitter ${tweetUrl} %}`);
  }

  const devData = {
    title: postDetail.data.title,
    published: true,
    main_image: postDetail.data.image,
    canonical_url: `https://readysetcloud.io/blog/${postDetail.data.slug.substring(1)}`,
    description: postDetail.data.description,
    tags: [...postDetail.data.categories.map(c => c.replace(/ /g, '')), ...postDetail.data.tags.map(t => t.toString().replace(/ /g, ''))],
    organization_id: 2491,
    body_markdown: devContent
  };

  return { article: devData };
};

const formatHashnodeData = (postDetail, catalog, links, tweets) => {
  let hashnodeContent = postDetail.content.slice(0);
  for (const link of links) {
    const replacement = catalog.find(c => c.links.M.url.S == link[1]);
    if (replacement) {
      if (replacement.links.M.hashnode?.S) {
        hashnodeContent = hashnodeContent.replace(link[1], replacement.links.M.hashnode.S);
      } else {
        hashnodeContent = hashnodeContent.replace(link[1], `https://readysetcloud.io${replacement.links.M.url.S}`);
      }
    }
  }

  for (const tweet of tweets) {
    const tweetUrl = getTweetUrl(tweet);
    hashnodeContent = hashnodeContent.replace(tweet[0], `%[${tweetUrl}]`);
  }

  const hashnodeData = {
    query: 'mutation PublishPost($input: PublishPostInput!){ publishPost( input: $input ){ post { slug }} }',
    variables: {
      input: {
        title: postDetail.data.title,
        subtitle: postDetail.data.description,
        publicationId: '626beb20b7dcabd258e7436c',
        contentMarkdown: hashnodeContent,
        coverImageOptions: {
          coverImageURL: postDetail.data.image,
          ...postDetail.data.image_attribution && { coverImageAttribution: postDetail.data.image_attribution }
        },
        originalArticleURL: `https://readysetcloud.io/blog/${postDetail.data.slug.substring(1)}`,
        tags: [
          ...postDetail.data.categories.map(c => {
            const tag = c.replace(/ /g, '');
            return {
              slug: tag,
              name: tag
            };
          }), ...postDetail.data.tags.map(t => {
            const tag = t.toString().replace(/ /g, '');
            return {
              slug: tag,
              name: tag
            };
          })
        ],
        metaTags: {
          title: postDetail.data.title,
          description: postDetail.data.description,
          image: postDetail.data.image
        }
      },
    }
  };

  return hashnodeData;
};

const getLinks = (postContent) => {
  const linkMatches = postContent.matchAll(/\(([^\)]*)\)/g);
  return linkMatches;
};

const getTweets = (postContent) => {
  const tweetMatches = postContent.matchAll(/\{\{<tweet user="([a-zA-Z0-9]*)" id="([\d]*)">\}\}/g);
  return tweetMatches;
};

const getTweetUrl = (tweet) => {
  return `https://twitter.com/${tweet[1]}/status/${tweet[2]}`;
};
