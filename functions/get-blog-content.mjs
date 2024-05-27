import { getFileContents } from "./utils/helpers.mjs";

export const handler = async (state) => {
  const content = await getFileContents(state.fileName);
  return { content };
};
