import { REST, Routes } from 'discord.js'
import { setupCommand, handleSetupCommand } from './setup.js'
import { trainsCommand, handleTrainsCommand } from './trains.js'
import {
  trainPingsCommand,
  trainPingsPanelCommand,
  handleTrainPingsCommand,
  handleTrainPingsPanelCommand,
  handleTrainPingsButton,
  isTrainPingsButton,
} from './trainPings.js'
import { patchNotesCommand, handlePatchNotesCommand } from './patchNotes.js'
import type { EnvConfig } from '../../config.js'
import type { GuildConfigManager } from '../../guildConfig.js'
import type { Client } from 'discord.js'

const commands = [
  setupCommand.toJSON(),
  trainsCommand.toJSON(),
  trainPingsCommand.toJSON(),
  trainPingsPanelCommand.toJSON(),
  patchNotesCommand.toJSON(),
]

export async function registerCommands(env: EnvConfig): Promise<void> {
  const rest = new REST({ version: '10' }).setToken(env.token)

  if (env.devGuildId) {
    await rest.put(Routes.applicationGuildCommands(env.clientId, env.devGuildId), {
      body: commands,
    })
    console.log(`Registered slash commands for dev guild ${env.devGuildId}`)
    return
  }

  await rest.put(Routes.applicationCommands(env.clientId), { body: commands })
  console.log('Registered global slash commands')
}

export function attachInteractionHandler(
  client: Client,
  guildConfig: GuildConfigManager,
): void {
  client.on('interactionCreate', async (interaction) => {
    try {
      if (interaction.isChatInputCommand()) {
        if (interaction.commandName === 'setup') {
          await handleSetupCommand(interaction, guildConfig)
        } else if (interaction.commandName === 'trains') {
          await handleTrainsCommand(interaction)
        } else if (interaction.commandName === 'train-pings') {
          await handleTrainPingsCommand(interaction)
        } else if (interaction.commandName === 'train-pings-panel') {
          await handleTrainPingsPanelCommand(interaction, guildConfig)
        } else if (interaction.commandName === 'patch-notes') {
          await handlePatchNotesCommand(interaction, guildConfig)
        }
        return
      }

      if (interaction.isButton() && isTrainPingsButton(interaction.customId)) {
        await handleTrainPingsButton(interaction, guildConfig)
      }
    } catch (err) {
      const label = interaction.isChatInputCommand()
        ? interaction.commandName
        : interaction.isButton()
          ? interaction.customId
          : 'interaction'
      console.error('[command]', label, err)
      const payload = { content: 'Something went wrong. Try again in a moment.', ephemeral: true }
      if (interaction.isRepliable()) {
        if (interaction.deferred || interaction.replied) {
          await interaction.followUp(payload).catch(() => {})
        } else {
          await interaction.reply(payload).catch(() => {})
        }
      }
    }
  })
}
