require("dotenv").config();
const { env } = require("../config/env");
const { createYouTubeClient, resolveChannelId, getUploadsPlaylistId, listUploadsVideos } = require("../services/youtube/client");
const { getActiveChannelId } = require("../services/admin/server_settings_store");

async function main() {
  try {
    const inputArg = process.argv[2];
    const useArg = Boolean(inputArg);
    const activeId = await getActiveChannelId();
    const input = useArg ? inputArg : activeId;
    if (!env.YOUTUBE_API_KEY) {
      console.error("YOUTUBE_API_KEY отсутствует.");
      process.exit(1);
    }
    if (!input) {
      console.error("Укажите канал через аргумент или установите активный канал в settings.json.");
      process.exit(1);
    }

    const client = createYouTubeClient(env.YOUTUBE_API_KEY);
    const channelId = await resolveChannelId(input, client);
    const uploadsId = await getUploadsPlaylistId(channelId, client);

    let total = 0;
    let token = undefined;
    while (true) {
      const page = await listUploadsVideos(uploadsId, client, token);
      const items = page.items || [];
      total += items.length;
      token = page.nextPageToken;
      if (!token) break;
    }

    process.stdout.write(String(total));
  } catch (err) {
    process.stdout.write("0");
    process.exit(1);
  }
}

main();