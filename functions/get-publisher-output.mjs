import { JSONPath } from "jsonpath-plus";

export const handler = async (state) => {
  const output = {
    url: getTransformedValue(state.result, state.url.format, state.url.path, state.url.template),
    id: getTransformedValue(state.result, state.id.format, state.id.path, state.id.template)
  };

  return { output };
};

const getTransformedValue = (result, format, path, template) => {
  let value = JSONPath({ path: path, json: result });
  if (format == 'composed') {
    value = template.replace('{}', value);
  }

  return value;
};
