import {
  PermissionFlagsBits,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
} from 'discord.js'
import { sendPatchNoteMessages } from '../patchNotesEmbed.js'
import type { GuildConfigManager } from '../../guildConfig.js'
import { fetchLatestPatchNoteDetail } from '../../lib/patchNotesApi.js'

export const patchNotesCommand = new SlashCommandBuilder()
  .setName('patch-notes')
  .setDescription('Odyssey patch notes')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .addSubcommand((sub) =>
    sub.setName('latest').setDescription('Post the full latest patch notes in this channel'),
  )
  .addSubcommand((sub) =>
    sub.setName('test').setDescription('Post the most recent patch note to the configured channel'),
  )

export async function handlePatchNotesCommand(
  interaction: ChatInputCommandInteraction,
  guildConfig: GuildConfigManager,
): Promise<void> {
  if (!interaction.guildId) {
    await interaction.reply({ content: 'This command can only be used in a server.', ephemeral: true })
    return
  }

  const sub = interaction.options.getSubcommand()
  if (sub === 'latest') {
    await postLatestPatchNotes(interaction, { test: false })
    return
  }
  if (sub !== 'test') return

  const cfg = guildConfig.get(interaction.guildId)
  if (!cfg.patchNotesChannelId) {
    await interaction.reply({
      content: 'Set a patch notes channel first with `/setup patch-notes-channel`.',
      ephemeral: true,
    })
    return
  }

  await postLatestPatchNotes(interaction, {
    test: true,
    channelId: cfg.patchNotesChannelId,
  })
}

async function postLatestPatchNotes(
  interaction: ChatInputCommandInteraction,
  options: { test: boolean; channelId?: string },
): Promise<void> {
  await interaction.deferReply({ ephemeral: true })

  try {
    const channel = options.channelId
      ? await interaction.client.channels.fetch(options.channelId)
      : (interaction.channel ??
        (interaction.channelId ? await interaction.client.channels.fetch(interaction.channelId) : null))
    if (!channel?.isTextBased() || channel.isDMBased()) {
      await interaction.editReply({
        content: options.channelId
          ? 'The configured patch notes channel is not reachable.'
          : 'This command can only be used in a text channel.',
      })
      return
    }

    const note = await fetchLatestPatchNoteDetail()
    const messageCount = await sendPatchNoteMessages(channel, note, { test: options.test })
    const parts = messageCount > 1 ? ` (${messageCount} messages)` : ''
    const where = options.channelId ? `to <#${options.channelId}>` : 'in this channel'
    const suffix = options.test ? ' (test preview; does not affect auto-post tracking)' : ''
    await interaction.editReply({
      content: `Posted the latest patch note${parts} ${where}.${suffix}`,
    })
  } catch (err) {
    console.error(`[patch-notes] ${options.test ? 'test' : 'latest'} failed:`, err)
    await interaction.editReply({ content: 'Could not load patch notes right now. Try again in a moment.' })
  }
}
