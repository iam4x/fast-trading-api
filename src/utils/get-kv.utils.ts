const snakeCase = (str: string) => {
  return str
    .replace(/([A-Z])/g, "_$1")
    .replace(/([a-z])([0-9])/g, "$1_$2")
    .toLowerCase();
};

const camelCase = (str: string) => {
  return str.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());
};

export const getKV = (obj: Record<string, any> | undefined, key: string) => {
  if (typeof obj === "undefined") return undefined;
  if (key in obj) return obj[key];
  if (snakeCase(key) in obj) return obj[snakeCase(key)];
  if (camelCase(key) in obj) return obj[camelCase(key)];
  return undefined;
};
