import {
  PermissionFlagsBits,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
} from 'discord.js'
import { buildPatchNoteEmbed } from '../patchNotesEmbed.js'
import type { GuildConfigManager } from '../../guildConfig.js'
import { fetchLatestPatchNoteDetail } from '../../lib/patchNotesApi.js'

export const patchNotesCommand = new SlashCommandBuilder()
  .setName('patch-notes')
  .setDescription('Odyssey patch notes')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
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
  if (sub !== 'test') return

  const cfg = guildConfig.get(interaction.guildId)
  if (!cfg.patchNotesChannelId) {
    await interaction.reply({
      content: 'Set a patch notes channel first with `/setup patch-notes-channel`.',
      ephemeral: true,
    })
    return
  }

  await interaction.deferReply({ ephemeral: true })

  try {
    const note = await fetchLatestPatchNoteDetail()
    const channel = await interaction.client.channels.fetch(cfg.patchNotesChannelId)
    if (!channel?.isTextBased() || channel.isDMBased()) {
      await interaction.editReply({ content: 'The configured patch notes channel is not reachable.' })
      return
    }

    await channel.send({ embeds: [buildPatchNoteEmbed(note, { test: true })] })
    await interaction.editReply({
      content: `Posted the latest patch note to <#${cfg.patchNotesChannelId}> (test preview; does not affect auto-post tracking).`,
    })
  } catch (err) {
    console.error('[patch-notes] test failed:', err)
    await interaction.editReply({ content: 'Could not load patch notes right now. Try again in a moment.' })
  }
}
