const axios = require("axios");
const { logger } = require("../../config/logger");
const { env } = require("../../config/env");

function createYouTubeClient(apiKey) {
  const key = apiKey || env.YOUTUBE_API_KEY;
  if (!key) throw new Error("YOUTUBE_API_KEY не задан");
  const client = axios.create({
    baseURL: "https://www.googleapis.com/youtube/v3",
    params: { key },
    timeout: 15000,
  });
  return client;
}

function isChannelId(str) {
  return /^UC[0-9A-Za-z_-]{22}$/.test(str);
}

function parseChannelIdFromUrl(input) {
  try {
    const u = new URL(input);
    const parts = u.pathname.split("/").filter(Boolean);
    if (parts[0] === "channel" && parts[1]) return parts[1];
    if (parts[0] && parts[0].startsWith("@")) return parts[0];
    if (parts[0] === "c" && parts[1]) return parts[1];
    if (parts[0] === "user" && parts[1]) return parts[1];
    return null;
  } catch {
    return null;
  }
}

async function resolveChannelId(input, client) {
  if (!input) throw new Error("Не задан канал для резолва");
  if (isChannelId(input)) return input;

  const parsed = parseChannelIdFromUrl(input);
  if (parsed && isChannelId(parsed)) return parsed;

  const c = client || createYouTubeClient();
  // Handle @handle or custom name via search.list
  let query = input;
  if (input.startsWith("@")) query = input.slice(1);
  if (parsed && !isChannelId(parsed)) query = parsed;

  // Try legacy username first if looks like simple name
  try {
    const respUsername = await c.get("/channels", {
      params: { part: "id", forUsername: query },
    });
    if (respUsername?.data?.items?.length) {
      return respUsername.data.items[0].id;
    }
  } catch (e) {
    logger.debug({ err: e?.response?.data || e.message }, "forUsername lookup failed, fallback to search");
  }

  const resp = await c.get("/search", {
    params: { part: "snippet", q: query, type: "channel", maxResults: 5 },
  });
  if (!resp.data.items?.length) {
    throw new Error(`Канал не найден по запросу: ${input}`);
  }
  return resp.data.items[0].id.channelId;
}

async function getUploadsPlaylistId(channelId, client) {
  const c = client || createYouTubeClient();
  const resp = await c.get("/channels", {
    params: { part: "contentDetails", id: channelId },
  });
  const item = resp.data.items?.[0];
  if (!item) throw new Error("Канал не найден по id");
  return item.contentDetails?.relatedPlaylists?.uploads;
}

async function listUploadsVideos(uploadsPlaylistId, client, pageToken) {
  const c = client || createYouTubeClient();
  const resp = await c.get("/playlistItems", {
    params: { part: "contentDetails", playlistId: uploadsPlaylistId, maxResults: 50, pageToken },
  });
  return resp.data;
}

async function getVideosDetails(videoIds, client) {
  const c = client || createYouTubeClient();
  const resp = await c.get("/videos", {
    params: { part: "snippet,contentDetails,liveStreamingDetails", id: videoIds.join(",") },
  });
  return resp.data.items || [];
}

module.exports = {
  createYouTubeClient,
  resolveChannelId,
  getUploadsPlaylistId,
  listUploadsVideos,
  getVideosDetails,
};