import {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  REST,
  Routes,
} from "discord.js";
import { MongoClient } from "mongodb";
import cron from "node-cron";
import "dotenv/config";

// ---- ENV VARIABLES ----
const TOKEN = process.env.TOKEN;
const NUT_CHANNEL_ID = process.env.NUT_CHANNEL_ID;
const MONGO_URI = process.env.MONGO_URI;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID;

// ---- MONGO SETUP ----
const clientDB = new MongoClient(MONGO_URI);
let collection;
let metaCollection;

async function connectDB() {
  await clientDB.connect();
  const db = clientDB.db("nutbot");
  collection = db.collection("nuts");
  metaCollection = db.collection("meta");

  const exists = await metaCollection.findOne({ _id: "counter" });
  if (!exists) {
    await metaCollection.insertOne({
      _id: "counter",
      lastNumber: 0,
      lastWeeklyReset: new Date(),
    });
  }

  console.log("Connected to MongoDB");
}

// ---- DATABASE FUNCTIONS ----

async function addNut(userId) {
  const user = await collection.findOne({ userId });

  if (!user) {
    const firstNutAt = new Date();
    await collection.insertOne({
      userId,
      nuts: 1,
      weeklyNuts: 1,
      firstNutAt,
    });

    return {
      nuts: 1,
      weeklyNuts: 1,
      firstNutAt,
      isMilestone: false,
    };
  }

  const newTotal = user.nuts + 1;
  const newWeekly = (user.weeklyNuts || 0) + 1;

  await collection.updateOne(
    { userId },
    { $set: { nuts: newTotal, weeklyNuts: newWeekly } }
  );

  return {
    nuts: newTotal,
    weeklyNuts: newWeekly,
    firstNutAt: user.firstNutAt,
    isMilestone: newTotal % 25 === 0,
  };
}

async function getUser(userId) {
  return await collection.findOne({ userId });
}

async function getLeaderboard() {
  return await collection.find({}).sort({ nuts: -1 }).toArray();
}

async function getWeeklyLeaderboard() {
  return await collection.find({}).sort({ weeklyNuts: -1 }).toArray();
}

// ---- DISCORD BOT ----
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

// ---- SLASH COMMANDS ----
const commands = [
  {
    name: "stats",
    description: "See a user's nut stats",
    options: [
      {
        name: "user",
        type: 6,
        description: "User to see stats for",
        required: true,
      },
    ],
  },
  {
    name: "mystats",
    description: "See your own nut stats",
  },
  {
    name: "compare",
    description: "Compare two users' nut stats",
    options: [
      {
        name: "user1",
        type: 6,
        description: "First user",
        required: true,
      },
      {
        name: "user2",
        type: 6,
        description: "Second user",
        required: true,
      },
    ],
  },
];

async function registerCommands() {
  const rest = new REST({ version: "10" }).setToken(TOKEN);

  await rest.put(
    Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID),
    { body: commands }
  );

  console.log("Slash commands registered.");
}

client.on("ready", () => {
  console.log(`NutBot is online as ${client.user.tag}`);
});

// ---- WEEKLY CRON JOB ----
cron.schedule("0 0 * * 0", async () => {
  const channel = await client.channels.fetch(NUT_CHANNEL_ID);
  const weeklyStats = await getWeeklyLeaderboard();

  if (weeklyStats.length === 0) return;

  const winner = weeklyStats[0];
  const userId = winner.userId;
  const weeklyNuts = winner.weeklyNuts || 0;

  const embed = new EmbedBuilder()
    .setTitle("🏅 **NUTTER OF THE WEEK** 🏅")
    .setDescription(
      `Congratulations <@${userId}>!\nYou nutted **${weeklyNuts} times** this week! 🥜`
    )
    .setColor("Gold")
    .setTimestamp();

  channel.send({ embeds: [embed] });

  await collection.updateMany({}, { $set: { weeklyNuts: 0 } });
});

// ---- MESSAGE HANDLER ----
client.on("messageCreate", async (msg) => {
  if (msg.author.bot) return;

  const content = msg.content.toLowerCase();

  // ---- COUNTING CHANNEL ----
  if (msg.channel.id === NUT_CHANNEL_ID) {
    if (/^\d+$/.test(msg.content)) {
      const number = parseInt(msg.content);

      let meta = await metaCollection.findOne({ _id: "counter" });
      const lastNumber = meta.lastNumber;

      if (number === lastNumber + 1) {
        await metaCollection.updateOne(
          { _id: "counter" },
          { $set: { lastNumber: number } }
        );

        const result = await addNut(msg.author.id);

        if (result.isMilestone) {
          const now = new Date();
          const diff = now - new Date(result.firstNutAt);

          const days = Math.floor(diff / (1000 * 60 * 60 * 24));
          const hours = Math.floor((diff / (1000 * 60 * 60)) % 24);
          const minutes = Math.floor((diff / (1000 * 60)) % 60);

          msg.channel.send(
            `🎉 Congratulations <@${msg.author.id}>!\n` +
              `You've nutted **${result.nuts} times** in ` +
              `**${days} days, ${hours} hours, ${minutes} minutes!** 🥜`
          );
        }
      }
    }
  }

  // ---- !nut ----
  if (content === "!nut") {
    const user = await getUser(msg.author.id);
    const nuts = user?.nuts || 0;
    msg.reply(`<@${msg.author.id}> has nutted **${nuts} times!** 🥜`);
  }

  // ---- !count ----
  if (content === "!count") {
    const meta = await metaCollection.findOne({ _id: "counter" });
    msg.reply(`The current global nut count is **${meta.lastNumber}** 🥜`);
  }

  // ---- !leaderboard ----
  if (content === "!leaderboard") {
    const results = await getLeaderboard();
    if (results.length === 0) return msg.reply("Nobody has nutted yet!");

    const embed = new EmbedBuilder()
      .setTitle("🏆 NUT LEADERBOARD 🏆")
      .setColor("Gold");

    results.forEach((u, i) => {
      embed.addFields({
        name: `#${i + 1} — <@${u.userId}>`,
        value: `**${u.nuts} lifetime nuts**`,
      });
    });

    msg.reply({ embeds: [embed] });
  }

  // ---- !weekly ----
  if (content === "!weekly") {
    const results = await getWeeklyLeaderboard();
    if (results.length === 0)
      return msg.reply("Nobody has nutted this week!");

    const embed = new EmbedBuilder()
      .setTitle("🏅 WEEKLY NUTTER LEADERBOARD 🏅")
      .setColor("Purple");

    results.forEach((u, i) => {
      embed.addFields({
        name: `#${i + 1} — <@${u.userId}>`,
        value: `**${u.weeklyNuts || 0} weekly nuts**`,
      });
    });

    msg.reply({ embeds: [embed] });
  }
});

// ---- SLASH COMMAND HANDLER ----
client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  // ----- /stats -----
  if (interaction.commandName === "stats") {
    const user = interaction.options.getUser("user");
    const stats = await getUser(user.id);

    const nuts = stats?.nuts || 0;
    const weekly = stats?.weeklyNuts || 0;
    const firstNutAt = stats?.firstNutAt
      ? new Date(stats.firstNutAt).toDateString()
      : "Unknown";

    const embed = new EmbedBuilder()
      .setTitle(`📇 ${user.username}'s Nut Stats`)
      .addFields(
        { name: "🥜 Lifetime Nuts", value: `${nuts}`, inline: true },
        { name: "📅 Weekly Nuts", value: `${weekly}`, inline: true },
        { name: "🕒 First Nut Recorded", value: firstNutAt, inline: false }
      )
      .setColor("Blue");

    await interaction.reply({ embeds: [embed] });
  }

  // ----- /mystats -----
  if (interaction.commandName === "mystats") {
    const user = interaction.user;
    const stats = await getUser(user.id);

    const nuts = stats?.nuts || 0;
    const weekly = stats?.weeklyNuts || 0;
    const firstNutAt = stats?.firstNutAt
      ? new Date(stats.firstNutAt).toDateString()
      : "Unknown";

    const embed = new EmbedBuilder()
      .setTitle(`📇 Your Nut Stats`)
      .addFields(
        { name: "🥜 Lifetime Nuts", value: `${nuts}`, inline: true },
        { name: "📅 Weekly Nuts", value: `${weekly}`, inline: true },
        { name: "🕒 First Nut Recorded", value: firstNutAt, inline: false }
      )
      .setColor("Green");

    await interaction.reply({ embeds: [embed] });
  }

  // ----- /compare -----
  if (interaction.commandName === "compare") {
    const user1 = interaction.options.getUser("user1");
    const user2 = interaction.options.getUser("user2");

    const stats1 = await getUser(user1.id);
    const stats2 = await getUser(user2.id);

    const nuts1 = stats1?.nuts || 0;
    const nuts2 = stats2?.nuts || 0;
    const weekly1 = stats1?.weeklyNuts || 0;
    const weekly2 = stats2?.weeklyNuts || 0;

    const winner =
      nuts1 > nuts2
        ? `<@${user1.id}> is winning! 🔥`
        : nuts2 > nuts1
        ? `<@${user2.id}> is winning! 🔥`
        : "It's a tie! 😳";

    const embed = new EmbedBuilder()
      .setTitle(`🥊 Nut Battle: ${user1.username} vs ${user2.username}`)
      .addFields(
        {
          name: `${user1.username}`,
          value: `**Lifetime:** ${nuts1}\n**Weekly:** ${weekly1}`,
          inline: true,
        },
        {
          name: `${user2.username}`,
          value: `**Lifetime:** ${nuts2}\n**Weekly:** ${weekly2}`,
          inline: true,
        },
        {
          name: "🏆 Status",
          value: winner,
          inline: false,
        }
      )
      .setColor("Red");

    await interaction.reply({ embeds: [embed] });
  }
});

// ---- STARTUP ----
(async () => {
  await connectDB();
  await registerCommands();
  client.login(TOKEN);
})();
