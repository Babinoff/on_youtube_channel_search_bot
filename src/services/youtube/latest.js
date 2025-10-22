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

  // Тип-ориентированная выборка: пагинируем плейлист загрузок, пока не наберём нужное количество
  const want = Math.max(1, Number(limit) || 1);
  let pageToken = undefined;
  const picked = [];

  while (picked.length < want) {
    const page = await client.listUploadsVideos(uploadsId, c, pageToken);
    const items = page.items || [];
    if (!items.length && !page.nextPageToken) break;

    const videoIds = items.map(i => i.contentDetails?.videoId).filter(Boolean);
    const details = videoIds.length ? await client.getVideosDetails(videoIds, c) : [];
    const mapped = details.map(v => video.toVideoEntity(v));

    if (type) {
      for (const m of mapped) {
        if ((m.type || 'video') === type) {
          picked.push(m);
          if (picked.length >= want) break;
        }
      }
    } else {
      // Без фильтра по типу просто берём в порядке загрузок
      for (const m of mapped) {
        picked.push(m);
        if (picked.length >= want) break;
      }
    }

    if (picked.length >= want) break;
    pageToken = page.nextPageToken;
    if (!pageToken) break; // достигли конца плейлиста
  }

  return picked.slice(0, want);
}

module.exports = { fetchLatestVideos, applyOrderingForLatest };