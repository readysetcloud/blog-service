export const handler = async (state) => {
  let status = state.record?.Item?.[state.publisher]?.M?.status?.S ?? 'none';
  return { status };
};
