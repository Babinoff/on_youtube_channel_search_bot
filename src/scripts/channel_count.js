require("dotenv").config();
const { env } = require("../config/env");
const { createYouTubeClient, resolveChannelId, getUploadsPlaylistId, listUploadsVideos } = require("../services/youtube/client");

async function main() {
  try {
    const inputArg = process.argv[2];
    const inputEnv = env.YOUTUBE_CHANNEL_ID || process.env.YOUTUBE_CHANNEL_ID;
    const input = inputEnv || inputArg;
    if (!env.YOUTUBE_API_KEY) {
      console.error("YOUTUBE_API_KEY отсутствует.");
      process.exit(1);
    }
    if (!input) {
      console.error("Укажите канал через .env (YOUTUBE_CHANNEL_ID) или аргумент.");
      process.exit(1);
    }

    const client = createYouTubeClient(env.YOUTUBE_API_KEY);
    const channelId = inputEnv ? inputEnv : await resolveChannelId(input, client);
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

    // Output only digits
    process.stdout.write(String(total));
  } catch (err) {
    // On error, print 0 to stdout to keep numeric-only contract
    process.stdout.write("0");
    process.exit(1);
  }
}

main();