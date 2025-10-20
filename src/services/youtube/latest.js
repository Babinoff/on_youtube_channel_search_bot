const { env } = require("../../config/env");
const client = require("./client");
const video = require("./video");

function applyOrderingForLatest(mapped, limit, type) {
  const limitN = Math.max(1, Number(limit) || 1);
  const filtered = type ? mapped.filter(v => (v.type || 'video') === type) : mapped;
  return filtered.slice(0, limitN);
}

async function fetchLatestVideos({ input, limit = 10, type = null }) {
  const c = client.createYouTubeClient(env.YOUTUBE_API_KEY);
  const channelId = input ? (input.match(/^UC/) ? input : await client.resolveChannelId(input, c)) : env.YOUTUBE_CHANNEL_ID;
  if (!channelId) throw new Error("Не задан канал: добавьте YOUTUBE_CHANNEL_ID в .env или укажите аргумент.");

  const uploadsId = await client.getUploadsPlaylistId(channelId, c);
  const page = await client.listUploadsVideos(uploadsId, c);
  const videoIdsAll = (page.items || []).map(i => i.contentDetails?.videoId).filter(Boolean);
  const detailsAll = videoIdsAll.length ? await client.getVideosDetails(videoIdsAll, c) : [];
  const mapped = detailsAll.map(v => video.toVideoEntity(v));

  return applyOrderingForLatest(mapped, limit, type);
}

module.exports = { fetchLatestVideos, applyOrderingForLatest };