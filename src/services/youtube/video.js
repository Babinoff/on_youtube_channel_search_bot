const { deriveType } = require("./classify");
const { cleanText } = require("../text/normalize");

function toVideoEntity(v) {
  const id = v.id;
  const title = cleanText(v.snippet?.title || "");
  const description = String(v.snippet?.description || "");
  const url = `https://youtu.be/${id}`;
  const publishedAt = v.snippet?.publishedAt || null;
  const type = deriveType(v);
  return { id, title, description, url, type, publishedAt };
}

module.exports = {
  toVideoEntity,
};