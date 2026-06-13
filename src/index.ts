import { Client, GatewayIntentBits, Partials } from 'discord.js'
import { loadEnvConfig } from './config.js'
import { GuildConfigManager } from './guildConfig.js'
import { registerCommands, attachInteractionHandler } from './discord/commands/index.js'
import { AlertPoller } from './poll/alertPoller.js'

async function main(): Promise<void> {
  const env = loadEnvConfig()
  const guildConfig = new GuildConfigManager(env)

  const client = new Client({
    intents: [GatewayIntentBits.Guilds],
    partials: [Partials.Channel],
  })

  const poller = new AlertPoller(client, env, guildConfig)

  attachInteractionHandler(client, guildConfig)

  client.once('ready', () => {
    console.log(`Logged in as ${client.user?.tag}`)
    poller.start()
    void registerCommands(env).catch((err) => {
      console.error('[startup] slash command registration failed:', err)
    })
  })

  await client.login(env.token)
}

main().catch((err) => {
  console.error('Fatal startup error:', err)
  process.exit(1)
})
