export const tickerSymbolFromId = (id: string) => {
  return id.replace(/-SWAP$/, "").replace(/-/g, "");
};
