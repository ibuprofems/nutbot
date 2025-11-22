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

// ---------------------------------------------------
// ✅ CRASH PROTECTION — prevents bot from ever dying
// ---------------------------------------------------
process.on("uncaughtException", (err) =>
  console.error("Uncaught Exception:", err)
);
process.on("unhandledRejection", (reason) =>
  console.error("Unhandled Rejection:", reason)
);

// ===== ENV VARIABLES =====
const TOKEN = process.env.TOKEN;
const NUT_CHANNEL_ID = process.env.NUT_CHANNEL_ID;
const MONGO_URI = process.env.MONGO_URI;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID;

// ===== MONGO SETUP =====
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

// ===== DATABASE FUNCTIONS =====
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

// ===== DISCORD CLIENT =====
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

// ===== NEW SLASH COMMANDS =====
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

  { name: "mystats", description: "See your own nut stats" },

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

  { name: "nut", description: "See how many times you have nutted" },
  { name: "count", description: "See the current global nut count" },
  { name: "leaderboard", description: "See the lifetime nut leaderboard" },
  { name: "weekly", description: "See the weekly nut leaderboard" },
  { name: "help", description: "Show all NutBot commands" },
];

async function registerCommands() {
  const rest = new REST({ version: "10" }).setToken(TOKEN);

  await rest.put(
    Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID),
    { body: commands }
  );

  console.log("Slash commands registered.");
}

// ---------------------------------------------------
// ⭐ UPDATED READY EVENT
// ---------------------------------------------------
client.on("clientReady", () => {
  console.log(`NutBot is online as ${client.user.tag}`);
});

// ===== WEEKLY CRON JOB =====
cron.schedule("0 0 * * 0", async () => {
  const channel = await client.channels.fetch(NUT_CHANNEL_ID);
  const weeklyStats = await getWeeklyLeaderboard();

  if (weeklyStats.length === 0) return;

  const winner = weeklyStats[0];

  const userObj = await client.users.fetch(winner.userId).catch(() => null);
  const username = userObj ? userObj.username : `Unknown (${winner.userId})`;

  const embed = new EmbedBuilder()
    .setTitle("🏅 **NUTTER OF THE WEEK** 🏅")
    .setDescription(
      `Congratulations **${username}**!\nYou nutted **${winner.weeklyNuts} times** this week! 🥜`
    )
    .setColor("Gold")
    .setTimestamp();

  channel.send({ embeds: [embed] });

  await collection.updateMany({}, { $set: { weeklyNuts: 0 } });
});

// ===== COUNTING CHANNEL HANDLER =====
client.on("messageCreate", async (msg) => {
  if (msg.author.bot) return;
  if (msg.channel.id !== NUT_CHANNEL_ID) return;

  if (/^\d+$/.test(msg.content)) {
    const number = parseInt(msg.content);

    const meta = await metaCollection.findOne({ _id: "counter" });
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
});

// ===== SLASH COMMAND HANDLER =====
client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  // ----- /nut -----
  if (interaction.commandName === "nut") {
    const stats = await getUser(interaction.user.id);
    const nuts = stats?.nuts || 0;

    return interaction.reply(
      `<@${interaction.user.id}> has nutted **${nuts} times!** 🥜`
    );
  }

  // ----- /count -----
  if (interaction.commandName === "count") {
    const meta = await metaCollection.findOne({ _id: "counter" });
    return interaction.reply(
      `The current global nut count is **${meta.lastNumber}** 🥜`
    );
  }

  // ----- /leaderboard (TOP 5) -----
  if (interaction.commandName === "leaderboard") {
    const results = await getLeaderboard();
    if (results.length === 0)
      return interaction.reply("Nobody has nutted yet!");

    const embed = new EmbedBuilder()
      .setTitle("🏆 NUT LEADERBOARD 🏆 (Top 5)")
      .setColor("Gold");

    for (let i = 0; i < Math.min(5, results.length); i++) {
      const u = results[i];
      const userObj = await client.users.fetch(u.userId).catch(() => null);
      const username = userObj ? userObj.username : `Unknown (${u.userId})`;

      embed.addFields({
        name: `#${i + 1} — ${username}`,
        value: `**${u.nuts} lifetime nuts**`,
      });
    }

    return interaction.reply({ embeds: [embed] });
  }

  // ----- /weekly (TOP 5) -----
  if (interaction.commandName === "weekly") {
    const results = await getWeeklyLeaderboard();
    if (results.length === 0)
      return interaction.reply("Nobody has nutted this week!");

    const embed = new EmbedBuilder()
      .setTitle("🏅 WEEKLY NUTTER LEADERBOARD 🏅 (Top 5)")
      .setColor("Purple");

    for (let i = 0; i < Math.min(5, results.length); i++) {
      const u = results[i];
      const userObj = await client.users.fetch(u.userId).catch(() => null);
      const username = userObj ? userObj.username : `Unknown (${u.userId})`;

      embed.addFields({
        name: `#${i + 1} — ${username}`,
        value: `**${u.weeklyNuts || 0} weekly nuts**`,
      });
    }

    return interaction.reply({ embeds: [embed] });
  }

  // ----- /help -----
  if (interaction.commandName === "help") {
    const embed = new EmbedBuilder()
      .setTitle("📘 NutBot Help Menu")
      .setDescription("Here are all available commands:")
      .addFields(
        { name: "/nut", value: "See how many times YOU have nutted." },
        { name: "/count", value: "See the global nut count." },
        { name: "/leaderboard", value: "Lifetime nut leaderboard (Top 5)." },
        { name: "/weekly", value: "Weekly nut leaderboard (Top 5)." },
        { name: "/stats @user", value: "View someone's stats." },
        { name: "/mystats", value: "View your own stats." },
        { name: "/compare @user1 @user2", value: "Compare two users." }
      )
      .setColor("Aqua");

    return interaction.reply({ embeds: [embed] });
  }

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

    return interaction.reply({ embeds: [embed] });
  }

  // ----- /mystats -----
  if (interaction.commandName === "mystats") {
    const stats = await getUser(interaction.user.id);

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

    return interaction.reply({ embeds: [embed] });
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
        ? `${user1.username} is winning! 🔥`
        : nuts2 > nuts1
        ? `${user2.username} is winning! 🔥`
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

    return interaction.reply({ embeds: [embed] });
  }
});

// ===== STARTUP =====
(async () => {
  await connectDB();
  await registerCommands();
  client.login(TOKEN);
})();
