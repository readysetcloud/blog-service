import { getFileContents } from "./utils/helpers.mjs";
import frontmatter from '@github-docs/frontmatter';

export const handler = async (state) => {
  const content = await getFileContents(state.fileName);
  let metadata;
  if (state.includeMetadata) {
    const blogMetadata = frontmatter(data);
    metadata = blogMetadata.data;
  }

  return {
    content,
    ...metadata && { metadata }
  };
};
